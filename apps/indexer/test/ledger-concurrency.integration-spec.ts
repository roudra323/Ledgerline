import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource, type QueryRunner } from "typeorm";

import { appDataSourceOptions, dataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingRequest } from "../src/ledger/ledger.types";
import { MetricsService } from "../src/observability/metrics.service";

/**
 * ADR-0017 accepts deadlocks as a correct (if surprising) failure mode and says callers "must be
 * prepared to retry." A deadlock-aborted attempt is a full ROLLBACK — nothing partial is left
 * behind — so retrying it from scratch (a fresh cause id, in these tests) is safe. Any other
 * rejection is a real, final answer and must propagate, never be retried away.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDeadlockRetry<T>(
  attempt: () => Promise<T>,
  stats: { deadlocks: number },
  maxRetries = 100,
): Promise<T> {
  for (let tryNumber = 0; tryNumber <= maxRetries; tryNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (/deadlock detected/i.test(message) && tryNumber < maxRetries) {
        stats.deadlocks += 1;
        // Jittered backoff: without it, every retrying transaction wakes up at the same instant
        // (Postgres's deadlock_timeout is a fixed ~1s), re-collides in lockstep, and the storm never
        // dissipates. This is what production callers would need too, not just this test.
        await sleep(10 + Math.random() * 90);
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable");
}

/**
 * Proves (or disproves) 1754006400007-LedgerNonNegativeLock.ts: the `FOR NO KEY UPDATE` lock added
 * to `assert_transaction_balances()` is meant to make concurrent commits touching the same account
 * serialise, so the non-negative check can no longer miss a concurrent transaction's uncommitted
 * entries (ADR-0017, docs/build-plan.md Part 1 exit criterion: "20 concurrent payouts against float
 * for 10 -> exactly 10 succeed").
 *
 * These tests post raw SQL directly against `ledger_entries`/`ledger_transactions`, the same way
 * `ledger-constraints.integration-spec.ts` does, because the thing under test is a database
 * trigger and constraint — a real race needs real concurrent connections, not a mock.
 */
describe("ledger non-negative lock — concurrency", () => {
  let ownerDataSource: DataSource;

  beforeAll(async () => {
    // The pool must exceed the largest test's concurrency, not merely beat pg's default of 10.
    // The barrier test parks every transaction mid-flight and commits them together, so it holds
    // `attempts` connections simultaneously — size the pool below that and phase 1 waits forever
    // for a connection that only phase 2 would release, which looks exactly like a database
    // deadlock and is not one.
    ownerDataSource = new DataSource({ ...dataSourceOptions, extra: { max: 70 } });
    await ownerDataSource.initialize();
  });

  afterAll(async () => {
    await ownerDataSource.destroy();
  });

  async function accountId(code: string, assetCode = "USD"): Promise<string> {
    const result = await ownerDataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_accounts WHERE code = $1 AND asset_code = $2 LIMIT 1`,
      [code, assetCode],
    );
    const row = result[0];
    if (!row) throw new Error(`no ledger_accounts row for code ${code}/${assetCode}`);
    return row.id;
  }

  /** Inserts a fresh, isolated account with a known allows_negative flag and zero history. */
  async function createTestAccount(allowsNegative: boolean, assetCode = "USD"): Promise<string> {
    const result = await ownerDataSource.query<{ id: string }[]>(
      `INSERT INTO ledger_accounts (code, name, account_type, normal_side, asset_code, owner_type, owner_id, allows_negative)
       VALUES ($1, 'test_concurrency_guard', 'asset', 'debit', $2, 'customer', gen_random_uuid(), $3)
       RETURNING id`,
      [`concurrency-${randomUUID()}`, assetCode, allowsNegative],
    );
    const row = result[0];
    if (!row) throw new Error("insert into ledger_accounts returned no row");
    return row.id;
  }

  /**
   * Posts one balanced two-leg transaction on its own connection/transaction: debits
   * `debitAccountId` and credits `creditAccountId` by `amountMinor`, in `assetCode`. Every call
   * gets its own `QueryRunner` — a real connection, not a mock — so that firing many of these with
   * `Promise.allSettled` produces a genuine race at the database, not a serialized event loop.
   */
  async function postLeg(
    debitAccountId: string,
    creditAccountId: string,
    amountMinor: number,
    assetCode: string,
    causeId: string,
  ): Promise<void> {
    const queryRunner: QueryRunner = ownerDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const txResult = (await queryRunner.query(
        `INSERT INTO ledger_transactions (kind, cause_type, cause_id)
         VALUES ('payout.requested', 'test', $1)
         RETURNING id`,
        [causeId],
      )) as { id: string }[];
      const txRow = txResult[0];
      if (!txRow) throw new Error("insert into ledger_transactions returned no row");
      const transactionId = txRow.id;

      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, 'debit', $3, $4, 0)`,
        [transactionId, debitAccountId, assetCode, amountMinor],
      );
      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, 'credit', $3, $4, 1)`,
        [transactionId, creditAccountId, assetCode, amountMinor],
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async function balanceOf(accountId_: string, assetCode = "USD"): Promise<bigint> {
    const result = await ownerDataSource.query<{ balance: string }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)::text AS balance
         FROM ledger_entries
        WHERE account_id = $1 AND asset_code = $2`,
      [accountId_, assetCode],
    );
    return BigInt(result[0]?.balance ?? "0");
  }

  /**
   * The exit-criterion test itself: 20 concurrent debits (payouts) of 1 unit each against an
   * `allows_negative = false` account holding exactly 10 units of float. If the trigger's balance
   * read can miss a concurrent commit's uncommitted entries (the pre-1754006400007 bug), more than
   * 10 of these can observe a same "balance still >= 1" snapshot and all pass, taking the account
   * negative. This test would catch that regression by finding fulfilled-count > 10 or a negative
   * final balance.
   */
  it("20 concurrent debits against float for 10 -> exactly 10 succeed, balance never negative", async () => {
    const float = await createTestAccount(false);
    const seedCounterparty = await accountId("1800"); // fx_clearing, allows_negative = true

    // Seed the float account with exactly 10 units before the race.
    await postLeg(float, seedCounterparty, 10, "USD", `seed-${randomUUID()}`);
    expect(await balanceOf(float)).toBe(10n);

    const attempts = 20;
    // Each attempt gets its OWN disposable, allows_negative=true counterparty rather than sharing
    // one (e.g. 1800): the float account is the thing under test, and it is already the one
    // deliberately-shared resource all 20 attempts must serialize on. Making them additionally
    // fight over a second shared row multiplies lock-ordering combinations for no reason connected
    // to what this test is proving, and it is what turned this into an unbounded deadlock storm the
    // first time this test was run — see the task report.
    const counterparties = await Promise.all(
      Array.from({ length: attempts }, () => createTestAccount(true)),
    );

    const deadlockStats = { deadlocks: 0 };
    // Deadlock-aborted attempts are retried (ADR-0017's "consequences" section explicitly requires
    // callers to do this) so the assertions below test the exit criterion itself — exactly 10
    // succeed — rather than how many happened to survive one particular deadlock round. The
    // console.info reports how many retries that actually took, which is the real finding here:
    // see the task report.
    const results = await Promise.allSettled(
      counterparties.map((counterparty) =>
        withDeadlockRetry(
          () => postLeg(counterparty, float, 1, "USD", `payout-${randomUUID()}`),
          deadlockStats,
        ),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    // console.info, not console.log: this is diagnostic output about lock contention under load,
    // not a step the test depends on. See the task report for the numbers this produced in practice.
    console.info(
      `[float-vs-20] deadlock retries observed: ${deadlockStats.deadlocks}, fulfilled: ${fulfilled.length}, rejected: ${rejected.length}`,
    );

    // After retries, every *final* rejection must be the non-negative guard — deadlocks are not a
    // final answer, they were retried away above. A rejection reaching here for any other reason
    // means something besides the float running out caused a payout to fail.
    for (const failure of rejected) {
      const message = String((failure.reason as Error)?.message ?? failure.reason);
      expect(message).toMatch(/allows_negative = false/i);
    }

    // This is Part 1's exit criterion, verbatim: exactly 10, not 11 (the pre-fix bug) and not fewer
    // (which would mean the lock is rejecting legitimate payouts, not just the 10 the float can't
    // cover).
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(attempts - 10);

    const finalBalance = await balanceOf(float);
    expect(finalBalance).toBe(0n);
    expect(finalBalance >= 0n).toBe(true);
  }, 120000);

  /**
   * **The regression test.** The test above states Part 1's exit criterion verbatim, but at 20
   * concurrent postings it passes with the lock *and without it* — the window between the trigger's
   * balance `SELECT` and its transaction's commit record is small enough that ordinary client
   * concurrency rarely lands two triggers inside it. A test that passes either way proves nothing.
   *
   * This one widens the window deliberately: every transaction does its INSERTs first and parks,
   * then all COMMITs are released at one instant, so the deferred triggers genuinely overlap.
   * Against the unlocked trigger (the pre-1754006400007 behaviour) this reliably admits more
   * postings than the float covers and leaves the account negative — measured at 13 of 50 against
   * float for 10, final balance −3. With the lock it admits exactly 10.
   */
  it("50 concurrent commits released together -> exactly 10 succeed, balance never negative", async () => {
    const float = await createTestAccount(false);
    const seedCounterparty = await createTestAccount(true);
    await postLeg(float, seedCounterparty, 10, "USD", `seed-${randomUUID()}`);

    const attempts = 50;
    const counterparties = await Promise.all(
      Array.from({ length: attempts }, () => createTestAccount(true)),
    );

    // Phase 1 — every transaction inserts its entries and stops short of COMMIT.
    const parked = await Promise.all(
      counterparties.map(async (counterparty) => {
        const queryRunner = ownerDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        const txResult = (await queryRunner.query(
          `INSERT INTO ledger_transactions (kind, cause_type, cause_id)
           VALUES ('payout.requested', 'test', $1) RETURNING id`,
          [`barrier-${randomUUID()}`],
        )) as { id: string }[];
        const transactionId = txResult[0]?.id;
        if (!transactionId) throw new Error("insert into ledger_transactions returned no row");
        await queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'debit', 'USD', 1, 0)`,
          [transactionId, counterparty],
        );
        await queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'credit', 'USD', 1, 1)`,
          [transactionId, float],
        );
        return queryRunner;
      }),
    );

    // Phase 2 — release every COMMIT at once, so all deferred triggers run concurrently.
    const outcomes = await Promise.all(
      parked.map(async (queryRunner) => {
        try {
          await queryRunner.commitTransaction();
          return "committed" as const;
        } catch (error) {
          if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
          return String((error as Error)?.message ?? error);
        } finally {
          await queryRunner.release();
        }
      }),
    );

    const committed = outcomes.filter((outcome) => outcome === "committed");
    const finalBalance = await balanceOf(float);

    // The assertion that would have failed before the lock existed.
    expect(finalBalance).toBeGreaterThanOrEqual(0n);
    expect(committed).toHaveLength(10);
    expect(finalBalance).toBe(0n);

    // Every rejection must be the guard firing, not a deadlock. FOR NO KEY UPDATE is compatible
    // with the KEY SHARE lock the composite foreign key takes at INSERT time; FOR UPDATE is not,
    // and with it this test deadlocks 49 of 50 attempts and takes ~55s instead of ~15ms.
    const deadlocked = outcomes.filter((outcome) => /deadlock detected/i.test(outcome));
    expect(deadlocked).toHaveLength(0);
  }, 120000);

  /**
   * The lock must not turn a *permitted* overdraft into spurious failures: an `allows_negative =
   * true` account (fx_clearing) must let every concurrent debit through, serialized or not. This
   * would catch a regression where the `FOR NO KEY UPDATE` lock (or a future rewrite of this trigger) adds
   * a rejection path that fires regardless of `allows_negative`.
   */
  it("20 concurrent debits against an allows_negative=true account (fx_clearing) -> all succeed", async () => {
    const fxClearingUsd = await accountId("1800");
    const attempts = 20;
    // One disposable counterparty per attempt (see the float test's comment above for why): fx_clearing
    // is the deliberately-shared account under test, and this keeps that the only shared lock.
    const counterparties = await Promise.all(
      Array.from({ length: attempts }, () => createTestAccount(true)),
    );

    const deadlockStats = { deadlocks: 0 };
    const results = await Promise.allSettled(
      counterparties.map((counterparty) =>
        withDeadlockRetry(
          () => postLeg(fxClearingUsd, counterparty, 1, "USD", `fx-race-${randomUUID()}`),
          deadlockStats,
        ),
      ),
    );

    console.info(`[fx-clearing-vs-20] deadlock retries observed: ${deadlockStats.deadlocks}`);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    for (const failure of rejected) {
      // Surface the actual reason in the test output if this ever fails — a permitted-overdraft
      // account should never reject for the non-negative reason, and every deadlock was retried
      // above, so nothing legitimate should still be sitting in `rejected`.
      throw new Error(
        `unexpected rejection against allows_negative=true account: ${String(failure.reason)}`,
      );
    }

    expect(fulfilled).toHaveLength(attempts);
    // Each counterparty is disposable and only this test writes to it, so summing all 20 balances
    // is an exact, uncontaminated measurement: every one of the 20 debits actually landed.
    const counterpartyBalances = await Promise.all(counterparties.map((id) => balanceOf(id)));
    const totalCounterpartyBalance = counterpartyBalances.reduce((sum, value) => sum + value, 0n);
    expect(totalCounterpartyBalance).toBe(-20n);
  }, 120000);
});

/**
 * Proves the `ON CONFLICT DO NOTHING` fix in AccountRegistryService.createMerchantAccount:
 * concurrent first-time postings for a brand-new merchant must all succeed, and exactly one
 * `ledger_accounts` row must be created for that (code, asset, merchant) — never zero (a lost
 * winner) and never more than one (the check-then-insert race this replaced).
 */
describe("AccountRegistryService.createMerchantAccount — concurrency", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;

  beforeAll(async () => {
    dataSource = new DataSource({ ...appDataSourceOptions, extra: { max: 30 } });
    await dataSource.initialize();
    const accounts = new AccountRegistryService(dataSource.getRepository(LedgerAccount));
    const metrics = new MetricsService(
      new Counter({
        name: "ledgerline_ledger_entries_written_total_concurrency_test",
        help: "test",
        labelNames: ["kind"],
        registers: [new Registry()],
      }),
    );
    ledger = new LedgerService(dataSource, accounts, metrics);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("K concurrent first postings for one new merchant -> all succeed, exactly one account row", async () => {
    const merchantId = randomUUID();
    const concurrency = 15;

    const request = (causeId: string): PostingRequest => ({
      kind: "onramp.settled",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        { accountCode: "1100", direction: "debit", assetCode: "USDX", amountMinor: "1" },
        {
          accountCode: "2000",
          direction: "credit",
          assetCode: "USDX",
          amountMinor: "1",
          merchantId,
        },
      ],
    });

    const deadlockStats = { deadlocks: 0 };
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        withDeadlockRetry(() => ledger.post(request(`evt_${randomUUID()}`)), deadlockStats),
      ),
    );

    console.info(`[merchant-account-race] deadlock retries observed: ${deadlockStats.deadlocks}`);

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    for (const failure of rejected) {
      throw new Error(
        `unexpected posting failure during merchant-creation race: ${String(failure.reason)}`,
      );
    }
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(concurrency);

    const merchantAccounts = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_accounts WHERE code = '2000' AND asset_code = 'USDX' AND owner_type = 'merchant' AND owner_id = $1`,
      [merchantId],
    );
    expect(merchantAccounts).toHaveLength(1);
  }, 120000);
});

/**
 * Proves the composite foreign key `ledger_entries_account_asset_fk` added by
 * 1754006400007-LedgerNonNegativeLock.ts actually bites at the database, independent of any
 * application-level check. Runs on the owner connection deliberately — the point is to prove the
 * CONSTRAINT rejects the row, not that a role's grants happen to prevent the attempt.
 */
describe("ledger_entries_account_asset_fk — asset/account mismatch", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(dataSourceOptions);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("rejects an entry whose asset_code does not match its account's configured asset", async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const usdAccount = await dataSource.query<{ id: string }[]>(
        `SELECT id FROM ledger_accounts WHERE code = '1000' AND asset_code = 'USD' LIMIT 1`,
      );
      const accountRow = usdAccount[0];
      if (!accountRow) throw new Error("no ledger_accounts row for code 1000/USD");

      const txResult = (await queryRunner.query(
        `INSERT INTO ledger_transactions (kind, cause_type, cause_id)
         VALUES ('payout.requested', 'test', $1)
         RETURNING id`,
        [`asset-mismatch-${randomUUID()}`],
      )) as { id: string }[];
      const txRow = txResult[0];
      if (!txRow) throw new Error("insert into ledger_transactions returned no row");

      // usdAccount is configured for USD — naming USDX on the entry must be rejected by the
      // composite FK (account_id, asset_code) -> ledger_accounts (id, asset_code), never silently
      // accepted and left for an ungrouped SUM to misreport later.
      await expect(
        queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'debit', 'USDX', 100, 0)`,
          [txRow.id, accountRow.id],
        ),
      ).rejects.toThrow(/violates foreign key constraint|ledger_entries_account_asset_fk/i);
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
  });
});
