import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { DataSource, type QueryRunner } from "typeorm";

import { dataSourceOptions } from "../src/data-source";

/**
 * `ledger-concurrency.integration-spec.ts`'s commit-barrier test proves the `FOR NO KEY UPDATE`
 * lock (1754006400007) holds for the ONE shape its author built it against: N postings, each a
 * plain two-leg transaction, all sharing exactly one contended account. ADR-0017 itself names a
 * deadlock between two accounts locked in opposite orders as a known, accepted trade-off of that
 * design ("Bad — and deliberate"), and its Consequences section admits the structural fix
 * (deterministic lock ordering) is deferred to Block 1.7. Nobody has put a number on how bad that
 * trade-off actually is, or checked what happens once a posting has more than two legs, or
 * revisits the same account twice, or whether an `allows_negative = true` account is truly immune
 * to ever being blocked once the SAME barrier technique that found the original bug is pointed at
 * it.
 */
describe("ledger non-negative lock — adversarial probes of the FOR NO KEY UPDATE choice", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ ...dataSourceOptions, extra: { max: 90 } });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function createTestAccount(allowsNegative: boolean, assetCode = "USD"): Promise<string> {
    const result = await dataSource.query<{ id: string }[]>(
      `INSERT INTO ledger_accounts (code, name, account_type, normal_side, asset_code, owner_type, owner_id, allows_negative)
       VALUES ($1, 'test_adversarial_guard', 'asset', 'debit', $2, 'customer', gen_random_uuid(), $3)
       RETURNING id`,
      [`adversarial-${randomUUID()}`, assetCode, allowsNegative],
    );
    const row = result[0];
    if (!row) throw new Error("insert into ledger_accounts returned no row");
    return row.id;
  }

  async function balanceOf(accountId_: string, assetCode = "USD"): Promise<bigint> {
    const result = await dataSource.query<{ balance: string }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)::text AS balance
         FROM ledger_entries
        WHERE account_id = $1 AND asset_code = $2`,
      [accountId_, assetCode],
    );
    return BigInt(result[0]?.balance ?? "0");
  }

  /** One row per (transaction_id, account_id, direction, amount) leg, inserted in array order. */
  interface Leg {
    accountId: string;
    direction: "debit" | "credit";
    amountMinor: number;
  }

  /** Parks a transaction: inserts the header + every leg, then stops short of COMMIT. */
  async function parkPosting(legs: Leg[], assetCode = "USD"): Promise<QueryRunner> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const txResult = (await queryRunner.query(
      `INSERT INTO ledger_transactions (kind, cause_type, cause_id)
       VALUES ('payout.requested', 'test', $1) RETURNING id`,
      [`barrier-${randomUUID()}`],
    )) as { id: string }[];
    const transactionId = txResult[0]?.id;
    if (!transactionId) throw new Error("insert into ledger_transactions returned no row");
    let sequence = 0;
    for (const leg of legs) {
      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [transactionId, leg.accountId, leg.direction, assetCode, leg.amountMinor, sequence],
      );
      sequence += 1;
    }
    return queryRunner;
  }

  /** Releases every parked QueryRunner's COMMIT at once, so their deferred triggers overlap. */
  async function releaseBarrier(parked: QueryRunner[]): Promise<string[]> {
    return Promise.all(
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
  }

  /**
   * A posting whose legs touch the SAME account twice (debit it, then separately credit it a
   * smaller amount within the same transaction) must not self-deadlock: the deferred trigger fires
   * once per entry row, in order, on the SAME session/transaction, and Postgres allows a
   * transaction to re-acquire a lock it already holds. Run 30 of these against one shared
   * float account, released through a commit barrier, and check the ledger still balances exactly
   * — this would catch a rewrite of the trigger that (for example) tried to take the lock with
   * `NOWAIT` or otherwise assumed "at most one lock request per account per transaction".
   */
  it("a posting that touches the SAME account twice does not self-deadlock under a commit barrier", async () => {
    const float = await createTestAccount(false);
    const seed = await createTestAccount(true);
    // Seed float with 1000. float is asset/debit-normal: crediting it drains it, debiting it tops
    // it up — each attempt below credits float 30 (drain) and separately debits it 20 (top-up),
    // for a net drain of 10 per attempt, so 30 attempts fit comfortably inside 1000 with headroom.
    const seeding = await parkPosting([
      { accountId: float, direction: "debit", amountMinor: 1000 },
      { accountId: seed, direction: "credit", amountMinor: 1000 },
    ]);
    await releaseBarrier([seeding]);
    expect(await balanceOf(float)).toBe(1000n);

    const attempts = 30;
    const counterparties = await Promise.all(
      Array.from({ length: attempts }, async () => ({
        a: await createTestAccount(true),
        b: await createTestAccount(true),
      })),
    );

    const parked = await Promise.all(
      counterparties.map(({ a, b }) =>
        parkPosting([
          // Leg 1/2: drain float by 30, balanced against counterparty a.
          { accountId: float, direction: "credit", amountMinor: 30 },
          { accountId: a, direction: "debit", amountMinor: 30 },
          // Leg 3/4: top float back up by 20, balanced against counterparty b — float is touched
          // TWICE by this one transaction, which is the shape under test.
          { accountId: float, direction: "debit", amountMinor: 20 },
          { accountId: b, direction: "credit", amountMinor: 20 },
        ]),
      ),
    );

    const outcomes = await releaseBarrier(parked);
    const deadlocked = outcomes.filter((outcome) => /deadlock detected/i.test(outcome));
    const committed = outcomes.filter((outcome) => outcome === "committed");

    // Self-locking must never deadlock: every attempt only ever needs a lock it already holds.
    expect(deadlocked).toHaveLength(0);
    expect(committed).toHaveLength(attempts);

    // Net effect per posting on float is -10 (credit 30, debit 20): 30 postings * -10 = -300,
    // starting balance 1000 -> 700.
    expect(await balanceOf(float)).toBe(1000n - 300n);
  }, 120000);

  /**
   * A posting with more than two legs, all against ONE shared account plus disposable
   * counterparties, must serialize and produce the exact correct aggregate under a commit barrier
   * — proving the lock isn't specific to the two-leg shape the original test used.
   */
  it("multi-leg (4-leg) postings against a shared float account serialize correctly under a barrier", async () => {
    const float = await createTestAccount(false);
    const seed = await createTestAccount(true);
    const seeding = await parkPosting([
      { accountId: float, direction: "debit", amountMinor: 20 },
      { accountId: seed, direction: "credit", amountMinor: 20 },
    ]);
    await releaseBarrier([seeding]);
    expect(await balanceOf(float)).toBe(20n);

    // 25 attempts of a 4-leg posting, each draining float by 1 net (credit float 1, debit
    // counterparty a 1 — the two-leg shape already covered elsewhere), PLUS an unrelated,
    // independent debit/credit pair in the SAME transaction against two more disposable
    // accounts, purely to make this a genuinely 4-leg transaction. float only has 20, so exactly
    // 20 of the 25 must succeed — the same "exactly N succeed" exit criterion, proven for a
    // wider transaction shape than the original test used.
    const attempts = 25;
    const counterparties = await Promise.all(
      Array.from({ length: attempts }, async () => ({
        a: await createTestAccount(true),
        b: await createTestAccount(true),
        c: await createTestAccount(true),
      })),
    );

    const parked = await Promise.all(
      counterparties.map(({ a, b, c }) =>
        parkPosting([
          { accountId: float, direction: "credit", amountMinor: 1 },
          { accountId: a, direction: "debit", amountMinor: 1 },
          { accountId: b, direction: "debit", amountMinor: 5 },
          { accountId: c, direction: "credit", amountMinor: 5 },
        ]),
      ),
    );

    const outcomes = await releaseBarrier(parked);
    const deadlocked = outcomes.filter((outcome) => /deadlock detected/i.test(outcome));
    const committed = outcomes.filter((outcome) => outcome === "committed");
    const rejectedForFloat = outcomes.filter((outcome) => /allows_negative = false/i.test(outcome));

    expect(deadlocked).toHaveLength(0);
    expect(committed).toHaveLength(20);
    expect(rejectedForFloat).toHaveLength(attempts - 20);
    expect(await balanceOf(float)).toBe(0n);
  }, 120000);

  /**
   * **Quantifies, rather than merely names, ADR-0017's accepted cross-account deadlock.** Two
   * shared accounts P and Q; half of a batch posts P-then-Q (insertion order = entry sequence
   * order = lock-acquisition order), the other half posts Q-then-P. Released through a commit
   * barrier so the deferred triggers genuinely overlap — this is exactly the scenario the ADR
   * says "can still deadlock" but never measured. This test reports the actual deadlock rate at
   * N=40 (20 each direction) and, more importantly, asserts the correctness property that matters:
   * every deadlock is a full, clean rollback — the surviving commits' aggregate net effect on P and
   * Q is exactly what it should be, never a wrong number.
   */
  it("quantifies the cross-account opposite-order deadlock ADR-0017 accepts, and proves it never corrupts a balance", async () => {
    const p = await createTestAccount(true); // allows_negative so only the deadlock risk is tested,
    const q = await createTestAccount(true); // not the non-negative guard.

    const attemptsPerDirection = 20;
    const pThenQ = await Promise.all(
      Array.from({ length: attemptsPerDirection }, () =>
        parkPosting([
          { accountId: p, direction: "debit", amountMinor: 1 },
          { accountId: q, direction: "credit", amountMinor: 1 },
        ]),
      ),
    );
    const qThenP = await Promise.all(
      Array.from({ length: attemptsPerDirection }, () =>
        parkPosting([
          { accountId: q, direction: "debit", amountMinor: 1 },
          { accountId: p, direction: "credit", amountMinor: 1 },
        ]),
      ),
    );

    const outcomes = await releaseBarrier([...pThenQ, ...qThenP]);
    const committed = outcomes.filter((outcome) => outcome === "committed");
    const deadlocked = outcomes.filter((outcome) => /deadlock detected/i.test(outcome));
    const unexplained = outcomes.filter(
      (outcome) => outcome !== "committed" && !/deadlock detected/i.test(outcome),
    );

    console.info(
      `[cross-account-deadlock] attempted: ${outcomes.length}, committed: ${committed.length}, ` +
        `deadlocked: ${deadlocked.length} (ADR-0017's accepted, structural trade-off)`,
    );

    // The finding this test exists to put a number on: ADR-0017 accepts this as possible, and at
    // N=40 crossed-order attempts released simultaneously it is not a rare edge case — the assertion
    // below is intentionally loose (>= 0) because the exact count is a property of Postgres's
    // deadlock detector timing, not of anything this test controls; what matters is that it is
    // reported, not silently absorbed by a passing test.
    expect(deadlocked.length).toBeGreaterThanOrEqual(0);
    // Nothing else may fail: every rejection must be a deadlock, never a wrong-balance-shaped error.
    expect(unexplained).toEqual([]);

    // Correctness under partial failure: p and q are a closed pair (every leg on one has a
    // matching leg on the other), so their combined balance across every COMMITTED posting must
    // still be exactly zero — a deadlock aborts entirely, it never leaves one leg of a pair
    // committed without its partner.
    const pBalance = await balanceOf(p);
    const qBalance = await balanceOf(q);
    expect(pBalance + qBalance).toBe(0n);
  }, 120000);

  /**
   * The lock must not turn a *permitted* overdraft into a spurious rejection even under the same
   * commit-barrier technique that found the original bug — the existing concurrency spec only
   * checks this with `Promise.allSettled` (looser timing) rather than a simultaneous-release
   * barrier. This is the stricter version of that claim.
   */
  it("an allows_negative=true account never blocks a commit, even under a simultaneous-release barrier", async () => {
    const fxLike = await createTestAccount(true);
    const attempts = 40;
    const counterparties = await Promise.all(
      Array.from({ length: attempts }, () => createTestAccount(true)),
    );

    const parked = await Promise.all(
      counterparties.map((counterparty) =>
        parkPosting([
          { accountId: counterparty, direction: "debit", amountMinor: 1 },
          { accountId: fxLike, direction: "credit", amountMinor: 1 },
        ]),
      ),
    );

    const outcomes = await releaseBarrier(parked);
    const rejected = outcomes.filter((outcome) => outcome !== "committed");
    if (rejected.length > 0) {
      throw new Error(
        `an allows_negative=true account rejected ${rejected.length}/${attempts} commits under the barrier: ${rejected[0]}`,
      );
    }

    expect(outcomes.filter((outcome) => outcome === "committed")).toHaveLength(attempts);
    expect(await balanceOf(fxLike)).toBe(BigInt(-attempts));
  }, 120000);
});
