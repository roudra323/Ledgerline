import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource, type QueryRunner } from "typeorm";

import type { AssetCode } from "@ledgerline/shared";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingLeg, PostingRequest } from "../src/ledger/ledger.types";
import { convert } from "../src/ledger/money";
import { MetricsService } from "../src/observability/metrics.service";

/**
 * Drives every posting docs/decisions/0018-ledger-flow-postings.md documents through the real
 * LedgerService.post() against the shared integration database, as the least-privilege app role.
 *
 * Platform accounts (1000, 1010, 1100, 1150, 1800, 1810, 2100, 2500, 3900, 4000) are singletons
 * every other spec file in this shared database also posts to — a committed row from this file
 * inflates one of them for good. So **nothing in this file ever commits**: every test opens its own
 * `QueryRunner`, runs its postings through `ledger.post(request, queryRunner)`, reads balances back
 * through that SAME queryRunner (so it sees its own uncommitted writes), runs
 * `SET CONSTRAINTS ALL IMMEDIATE` to fire the deferred balance/non-negative trigger exactly as
 * COMMIT would, asserts, and rolls the transaction back in a `finally`. A rejection test asserts on
 * the rejection of either `ledger.post()` itself (a synchronous validation, e.g. a cross-asset
 * mismatch) or of `SET CONSTRAINTS ALL IMMEDIATE` (a deferred trigger, e.g. an overdraw) — whichever
 * one the ADR's posting is actually rejected by.
 *
 * Because nothing commits, every test is self-contained: it snapshots the accounts it cares about
 * at the start of its own transaction, drives its own scenario, and asserts the delta within that
 * same transaction. No test depends on another test's order or on any shared accumulator.
 *
 * Every merchant account (1300/2000/2010/2200) is still scoped to a fresh `randomUUID()`
 * merchantId per scenario, and every cause id this file generates is prefixed with `RUN_PREFIX` so
 * the final "no residue" test can prove, from a real committed read, that the file left nothing
 * behind.
 */
describe("ADR-0018 ledger flow postings", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;
  const USD: AssetCode = "USD";
  const USDX: AssetCode = "USDX";
  const USD_DECIMALS = 2;
  const USDX_DECIMALS = 6;
  const ONE = "1"; // 1:1 rate numerator/denominator used throughout the ADR's worked example

  // Every cause id this file posts is prefixed with this, so the final "no residue" test can find
  // (and assert the absence of) every row this file could possibly have committed, without needing
  // to enumerate them by hand.
  const RUN_PREFIX = `ledger-flows-test-${randomUUID()}`;

  beforeAll(async () => {
    dataSource = new DataSource(appDataSourceOptions);
    await dataSource.initialize();
    const accounts = new AccountRegistryService(dataSource.getRepository(LedgerAccount));
    const metrics = new MetricsService(
      new Counter({
        name: "ledgerline_ledger_entries_written_total_flows_test",
        help: "test",
        labelNames: ["kind"],
        registers: [new Registry()],
      }),
      new Counter({
        name: "ledgerline_ledger_postings_rejected_total",
        help: "test",
        labelNames: ["kind", "reason_class"],
        registers: [new Registry()],
      }),
    );
    ledger = new LedgerService(dataSource, accounts, metrics);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  /** Anything with a TypeORM-shaped `.query(sql, params)` — a plain `DataSource` or a `QueryRunner`. */
  type Queryable = DataSource | QueryRunner;

  /**
   * Balance of one account, signed so that a positive number always means "more of its normal
   * side" — i.e. accounting balance, not raw debit-minus-credit. Returns 0n for a merchant account
   * that has not been created yet, which is the correct pre-creation balance, not a missing-row
   * error. Reading through a `QueryRunner` mid-transaction sees that transaction's own uncommitted
   * writes; reading through `dataSource` only ever sees committed state.
   */
  async function signedBalance(
    runner: Queryable,
    code: string,
    assetCode: AssetCode,
    ownerType: "platform" | "merchant" = "platform",
    ownerId: string | null = null,
  ): Promise<bigint> {
    const accountRows = (await runner.query(
      `SELECT id, normal_side FROM ledger_accounts
        WHERE code = $1 AND asset_code = $2 AND owner_type = $3 AND owner_id IS NOT DISTINCT FROM $4`,
      [code, assetCode, ownerType, ownerId],
    )) as { id: string; normal_side: string }[];
    const account = accountRows[0];
    if (!account) return 0n;

    const sumRows = (await runner.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = $2 THEN amount_minor ELSE -amount_minor END), 0)::text AS balance
         FROM ledger_entries WHERE account_id = $1`,
      [account.id, account.normal_side],
    )) as { balance: string }[];
    return BigInt(sumRows[0]?.balance ?? "0");
  }

  async function headerExists(
    runner: Queryable,
    kind: string,
    causeType: string,
    causeId: string,
  ): Promise<boolean> {
    const rows = (await runner.query(
      `SELECT id FROM ledger_transactions WHERE kind = $1 AND cause_type = $2 AND cause_id = $3`,
      [kind, causeType, causeId],
    )) as { id: string }[];
    return rows.length > 0;
  }

  /**
   * Per-asset trial balance for exactly the transactions one test posted: `Σ debits = Σ credits`
   * per asset (conventions.md §11's #2 load-bearing test), scoped to this test's own transaction ids
   * so it says something about this scenario, not the whole shared table.
   */
  async function assertTrialBalance(
    queryRunner: QueryRunner,
    transactionIds: readonly string[],
  ): Promise<void> {
    expect(transactionIds.length).toBeGreaterThan(0);
    const rows = (await queryRunner.query(
      `SELECT asset_code,
              COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)::text AS delta
         FROM ledger_entries
        WHERE transaction_id = ANY($1)
        GROUP BY asset_code`,
      [transactionIds],
    )) as { asset_code: string; delta: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.delta).toBe("0");
    }
  }

  /**
   * A `post()` wrapper bound to one test's `QueryRunner`, recording every transaction id it created
   * so the caller can run `assertTrialBalance` at the end without threading an array through by hand.
   */
  function makePoster(queryRunner: QueryRunner): {
    post: (request: PostingRequest) => Promise<{ transactionId: string }>;
    postedTransactionIds: string[];
  } {
    const postedTransactionIds: string[] = [];
    return {
      postedTransactionIds,
      post: async (request: PostingRequest) => {
        const result = await ledger.post(request, queryRunner);
        postedTransactionIds.push(result.transactionId);
        return result;
      },
    };
  }

  function leg(
    accountCode: string,
    direction: "debit" | "credit",
    assetCode: AssetCode,
    amountMinor: string,
    merchantId?: string,
  ): PostingLeg {
    // exactOptionalPropertyTypes forbids `merchantId: undefined` on an optional field — omit the
    // key entirely for platform legs instead of assigning it explicitly.
    return merchantId === undefined
      ? { accountCode, direction, assetCode, amountMinor }
      : { accountCode, direction, assetCode, amountMinor, merchantId };
  }

  /**
   * Runs T1 (capture), T3 (fx) and T4 (reserve) of the $100.00, 1% fee, 1:1 worked example for a
   * fresh merchant, and returns the numbers so callers can continue to T5, freeze, or refund it.
   * Mirrors ADR-0018's own worked example exactly, using convert() rather than hand-computed
   * numbers so a change to the conversion math would fail this test too.
   */
  async function runOnrampThroughReserve(
    post: (request: PostingRequest) => Promise<{ transactionId: string }>,
    merchantId: string,
  ): Promise<{
    causeId: string;
    captureUsd: string;
    feeUsd: string;
    netUsdxMinor: string;
  }> {
    const causeId = `${RUN_PREFIX}-onramp-${randomUUID()}`;
    const captureUsd = "10000"; // $100.00
    const feeUsd = "100"; // 1%
    const clearingUsd = "9900"; // captureUsd - feeUsd

    await post({
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: causeId },
      entries: [leg("1000", "debit", USD, captureUsd), leg("2100", "credit", USD, captureUsd)],
    });

    const { amount: netUsdxMinor, residual } = convert(
      clearingUsd,
      USD_DECIMALS,
      USDX_DECIMALS,
      ONE,
      ONE,
    );
    // The worked example is exact at a 1:1 rate — a nonzero residual here would mean convert()'s
    // own scale-folding regressed, not something this flow test should silently tolerate.
    expect(residual).toBe("0");
    expect(netUsdxMinor).toBe("99000000");

    await post({
      kind: "onramp.fx",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        leg("2100", "debit", USD, captureUsd),
        leg("4000", "credit", USD, feeUsd),
        leg("1800", "credit", USD, clearingUsd),
        leg("1810", "debit", USDX, netUsdxMinor),
        leg("2000", "credit", USDX, netUsdxMinor, merchantId),
      ],
    });

    await post({
      kind: "onramp.reserve",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        leg("1150", "debit", USDX, netUsdxMinor),
        leg("1100", "credit", USDX, netUsdxMinor),
      ],
    });

    return { causeId, captureUsd, feeUsd, netUsdxMinor };
  }

  /**
   * Mints comfortably more USDX into 1100 than any single scenario in this file ever reserves, so
   * `onramp.reserve`'s draw-down never risks the deferred non-negative trigger. Every scenario now
   * runs inside its own rolled-back transaction with none of the OTHER tests' committed float to
   * draw on — unlike the old shared-database version of this file, this treasury float must be
   * minted fresh, inside the same transaction, before anything reserves against it. Callers that
   * assert a before/after delta on 1100 must call this BEFORE taking their "before" snapshot.
   */
  async function fundTreasuryFloat(
    post: (request: PostingRequest) => Promise<{ transactionId: string }>,
  ): Promise<void> {
    const amount = "1000000000"; // 1000 USDX
    await post({
      kind: "treasury.mint",
      cause: { type: "treasury_event", id: `${RUN_PREFIX}-fund-float-${randomUUID()}` },
      entries: [leg("1100", "debit", USDX, amount), leg("2500", "credit", USDX, amount)],
    });
  }

  /**
   * Funds 1000 (psp_receivable) with an `onramp.capture` so a later `treasury.psp_sweep` in the
   * same transaction can credit it down without the deferred non-negative trigger rejecting the
   * draw — the mirror of `fundTreasuryFloat` for the USD cash side.
   */
  async function fundCashFloat(
    post: (request: PostingRequest) => Promise<{ transactionId: string }>,
    amount: string,
  ): Promise<void> {
    await post({
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: `${RUN_PREFIX}-fund-cash-${randomUUID()}` },
      entries: [leg("1000", "debit", USD, amount), leg("2100", "credit", USD, amount)],
    });
  }

  describe("treasury operations", () => {
    it("treasury.mint (T0) credits 2500 and debits 1100 by the same amount — issuance is a treasury posting, not a payment's", async () => {
      // This is the exact claim ADR-0018 makes to replace the old T3, which credited 2500 on every
      // payment: if a bare mint doesn't move 1100 and 2500 together, I3 (2500 tracks totalSupply())
      // cannot hold by construction as the ADR claims.
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const amount = "1000000000"; // 1000 USDX
        const before1100 = await signedBalance(queryRunner, "1100", USDX);
        const before2500 = await signedBalance(queryRunner, "2500", USDX);

        const causeId = `${RUN_PREFIX}-mint-${randomUUID()}`;
        await post({
          kind: "treasury.mint",
          cause: { type: "treasury_event", id: causeId },
          entries: [leg("1100", "debit", USDX, amount), leg("2500", "credit", USDX, amount)],
        });

        expect((await signedBalance(queryRunner, "1100", USDX)) - before1100).toBe(BigInt(amount));
        // I3: this transaction's only USDX movement is one mint — 2500's delta must equal exactly
        // what was minted, with nothing burned inside it to net against.
        expect((await signedBalance(queryRunner, "2500", USDX)) - before2500).toBe(BigInt(amount));

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });

    it("treasury.psp_sweep (T0) debits 1010 and credits 1000 by the same amount — the cash a fiat payout later draws on", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const amount = "5000"; // $50.00
        const causeId = `${RUN_PREFIX}-sweep-${randomUUID()}`;
        await post({
          kind: "onramp.capture",
          cause: { type: "fiat_event", id: `${RUN_PREFIX}-capture-for-${causeId}` },
          entries: [leg("1000", "debit", USD, amount), leg("2100", "credit", USD, amount)],
        });

        const before1000 = await signedBalance(queryRunner, "1000", USD);
        const before1010 = await signedBalance(queryRunner, "1010", USD);

        await post({
          kind: "treasury.psp_sweep",
          cause: { type: "treasury_event", id: causeId },
          entries: [leg("1010", "debit", USD, amount), leg("1000", "credit", USD, amount)],
        });

        expect((await signedBalance(queryRunner, "1010", USD)) - before1010).toBe(BigInt(amount));
        expect((await signedBalance(queryRunner, "1000", USD)) - before1000).toBe(-BigInt(amount));

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });
  });

  describe("on-ramp — $100.00, 1% fee, 1:1 (T1/T3/T4/T5)", () => {
    it("T1 capture debits 1000 and credits 2100 by the captured amount", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        await fundTreasuryFloat(post); // so T4 inside the helper never overdraws 1100
        const before1000 = await signedBalance(queryRunner, "1000", USD);
        const before2100 = await signedBalance(queryRunner, "2100", USD);
        const { captureUsd } = await runOnrampThroughReserve(post, merchantId);
        // runOnrampThroughReserve also posts T3/T4, so re-derive T1's isolated effect: 2100 nets to
        // capture - capture (T3 debits it straight back down) = 0 delta; 1000 only ever moves at T1.
        expect((await signedBalance(queryRunner, "1000", USD)) - before1000).toBe(
          BigInt(captureUsd),
        );
        expect((await signedBalance(queryRunner, "2100", USD)) - before2100).toBe(0n);

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });

    it("T3 fx: 1800 loses the net USD, 1810 gains the net USDX, 4000 gains the fee, merchant 2000 gains the full net as an IOU", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        await fundTreasuryFloat(post); // so T4 inside the helper never overdraws 1100
        const before1800 = await signedBalance(queryRunner, "1800", USD);
        const before1810 = await signedBalance(queryRunner, "1810", USDX);
        const before4000 = await signedBalance(queryRunner, "4000", USD);

        const { feeUsd, netUsdxMinor } = await runOnrampThroughReserve(post, merchantId);

        expect((await signedBalance(queryRunner, "1800", USD)) - before1800).toBe(-BigInt("9900"));
        expect((await signedBalance(queryRunner, "1810", USDX)) - before1810).toBe(
          BigInt(netUsdxMinor),
        );
        expect((await signedBalance(queryRunner, "4000", USD)) - before4000).toBe(BigInt(feeUsd));
        // T3 writes the IOU; nothing has torn it up yet (no T5 in this scenario).
        expect(await signedBalance(queryRunner, "2000", USDX, "merchant", merchantId)).toBe(
          BigInt(netUsdxMinor),
        );

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });

    it("T4 reserve draws down 1100 and stages 1150 by the net amount", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        await fundTreasuryFloat(post); // minted before the "before" snapshot so it nets out of the delta below
        const before1100 = await signedBalance(queryRunner, "1100", USDX);
        const before1150 = await signedBalance(queryRunner, "1150", USDX);
        const { netUsdxMinor } = await runOnrampThroughReserve(post, merchantId);
        expect((await signedBalance(queryRunner, "1100", USDX)) - before1100).toBe(
          -BigInt(netUsdxMinor),
        );
        expect((await signedBalance(queryRunner, "1150", USDX)) - before1150).toBe(
          BigInt(netUsdxMinor),
        );
        // I4: T4 only moves tokens between 1100 and 1150 — custody as a whole is unaffected.
        const custodyBefore = before1100 + before1150;
        const custodyAfter =
          (await signedBalance(queryRunner, "1100", USDX)) +
          (await signedBalance(queryRunner, "1150", USDX));
        expect(custodyAfter - custodyBefore).toBe(0n);

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });

    it("T5 settled tears up the IOU: merchant 2000 returns to zero, 1150 is drawn down by the same amount — tokens have now left custody", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        await fundTreasuryFloat(post); // minted before the "before" snapshot so it nets out of the delta below
        const before1100 = await signedBalance(queryRunner, "1100", USDX);
        const before1150 = await signedBalance(queryRunner, "1150", USDX);
        const { causeId, netUsdxMinor } = await runOnrampThroughReserve(post, merchantId);

        expect(await signedBalance(queryRunner, "2000", USDX, "merchant", merchantId)).toBe(
          BigInt(netUsdxMinor),
        );

        await post({
          kind: "onramp.settled",
          cause: { type: "fiat_event", id: causeId },
          entries: [
            leg("2000", "debit", USDX, netUsdxMinor, merchantId),
            leg("1150", "credit", USDX, netUsdxMinor),
          ],
        });

        expect(await signedBalance(queryRunner, "2000", USDX, "merchant", merchantId)).toBe(0n);
        expect((await signedBalance(queryRunner, "1150", USDX)) - before1150).toBe(0n);
        // I4: T5 permanently removes the net amount from custody (1100 + 1150 combined).
        const custodyAfter =
          (await signedBalance(queryRunner, "1100", USDX)) +
          (await signedBalance(queryRunner, "1150", USDX));
        expect(custodyAfter - (before1100 + before1150)).toBe(-BigInt(netUsdxMinor));

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });

    it("T4 larger than the current 1100 float is rejected at COMMIT, and leaves no ledger_transactions header", async () => {
      // Reserve exactly one more than 1100 currently holds, whatever that live (committed) balance
      // is — this must fail regardless of how much other scenarios in this file (or other spec files
      // sharing the database) have already minted or drawn down. Read from `dataSource`, not a
      // queryRunner, because this snapshot must reflect real committed state: this file's other
      // tests never commit anything, so it is exactly the persistent balance every run sees.
      const float = await signedBalance(dataSource, "1100", USDX);
      const before1150 = await signedBalance(dataSource, "1150", USDX);
      const overAmount = (float + 1n).toString();
      const causeId = `${RUN_PREFIX}-overdraw-${randomUUID()}`;

      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        // post() resolves here — the deferred trigger has not run yet. It fires below.
        await ledger.post(
          {
            kind: "onramp.reserve",
            cause: { type: "fiat_event", id: causeId },
            entries: [
              leg("1150", "debit", USDX, overAmount),
              leg("1100", "credit", USDX, overAmount),
            ],
          },
          queryRunner,
        );

        await expect(queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow(
          /allows_negative = false/i,
        );
      } finally {
        // The rejection is a deferred-trigger failure, inside the same transaction that inserted the
        // header — the whole transaction rolls back, so neither the header nor the entries survive.
        // A header with no entries would be an orphan the immutability trigger then makes permanent.
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }

      expect(await headerExists(dataSource, "onramp.reserve", "fiat_event", causeId)).toBe(false);
      expect(await signedBalance(dataSource, "1100", USDX)).toBe(float);
      expect(await signedBalance(dataSource, "1150", USDX)).toBe(before1150);
    });
  });

  describe("B16 — blacklisted before settlement (compliance.frozen)", () => {
    it("reclassifies the obligation into 2200 and releases the reservation, without T5 ever running", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        await fundTreasuryFloat(post); // minted before the "before" snapshot so it nets out of the delta below
        const before1100 = await signedBalance(queryRunner, "1100", USDX);
        const before1150 = await signedBalance(queryRunner, "1150", USDX);
        const { causeId, netUsdxMinor } = await runOnrampThroughReserve(post, merchantId);

        await post({
          kind: "compliance.frozen",
          cause: { type: "compliance_event", id: causeId },
          entries: [
            leg("2000", "debit", USDX, netUsdxMinor, merchantId),
            leg("2200", "credit", USDX, netUsdxMinor, merchantId),
            leg("1100", "debit", USDX, netUsdxMinor),
            leg("1150", "credit", USDX, netUsdxMinor),
          ],
        });
        // Frees the reservation (undoes T4) and reclassifies the merchant's obligation — the tokens
        // never left custody, so custody (1100 + 1150 combined) does not move.

        expect(await signedBalance(queryRunner, "2000", USDX, "merchant", merchantId)).toBe(0n);
        expect(await signedBalance(queryRunner, "2200", USDX, "merchant", merchantId)).toBe(
          BigInt(netUsdxMinor),
        );
        // T4 drew 1100 down and staged 1150 up; the freeze reverses both, so both are back to their
        // pre-T4 (== pre-scenario) level.
        expect(await signedBalance(queryRunner, "1100", USDX)).toBe(before1100);
        expect(await signedBalance(queryRunner, "1150", USDX)).toBe(before1150);

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });
  });

  describe("refund — after settlement, the platform keeps its fee", () => {
    it("a full $100 refund reclaims all 99 USDX, credits 1000 for the refund, and leaves exactly $1 of merchant debt in 1300", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        await fundTreasuryFloat(post); // so T4 inside the helper never overdraws 1100
        const { causeId, netUsdxMinor } = await runOnrampThroughReserve(post, merchantId);
        await post({
          kind: "onramp.settled",
          cause: { type: "fiat_event", id: causeId },
          entries: [
            leg("2000", "debit", USDX, netUsdxMinor, merchantId),
            leg("1150", "credit", USDX, netUsdxMinor),
          ],
        });

        const before1100 = await signedBalance(queryRunner, "1100", USDX);
        const before1810 = await signedBalance(queryRunner, "1810", USDX);
        const before1800 = await signedBalance(queryRunner, "1800", USD);
        const before1000 = await signedBalance(queryRunner, "1000", USD);
        const before4000 = await signedBalance(queryRunner, "4000", USD);

        const refundUsd = "10000"; // full $100 refund
        const reclaimed = netUsdxMinor; // full 99 USDX reclaimed, per the ADR's worked example
        const refundCauseId = `${RUN_PREFIX}-refund-${randomUUID()}`;

        await post({
          kind: "refund.chain_reversed",
          cause: { type: "fiat_event", id: refundCauseId },
          entries: [leg("1100", "debit", USDX, reclaimed), leg("1810", "credit", USDX, reclaimed)],
        });

        const { amount: reclaimedUsd } = convert(reclaimed, USDX_DECIMALS, USD_DECIMALS, ONE, ONE);
        const shortfallUsd = (BigInt(refundUsd) - BigInt(reclaimedUsd)).toString();
        expect(reclaimedUsd).toBe("9900");
        expect(shortfallUsd).toBe("100"); // exactly the 1% fee — the platform keeps it

        await post({
          kind: "refund.fiat_returned",
          cause: { type: "fiat_event", id: refundCauseId },
          entries: [
            leg("1800", "debit", USD, reclaimedUsd),
            leg("1300", "debit", USD, shortfallUsd, merchantId),
            leg("1000", "credit", USD, refundUsd),
          ],
        });

        expect((await signedBalance(queryRunner, "1100", USDX)) - before1100).toBe(
          BigInt(reclaimed),
        );
        expect((await signedBalance(queryRunner, "1810", USDX)) - before1810).toBe(
          -BigInt(reclaimed),
        );
        expect((await signedBalance(queryRunner, "1800", USD)) - before1800).toBe(
          BigInt(reclaimedUsd),
        );
        expect((await signedBalance(queryRunner, "1000", USD)) - before1000).toBe(
          -BigInt(refundUsd),
        );
        expect(await signedBalance(queryRunner, "1300", USD, "merchant", merchantId)).toBe(
          BigInt(shortfallUsd),
        );
        // "4000 fee_revenue is untouched" — ADR-0018's own words. If a future refund implementation
        // reverses the fee too, this is the line that must change, and it must change on purpose.
        expect((await signedBalance(queryRunner, "4000", USD)) - before4000).toBe(0n);

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });

    it("two $50 refunds reclaim 50 then 49 USDX (capped at what remains refundable) — only the second creates merchant debt", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        await fundTreasuryFloat(post); // so T4 inside the helper never overdraws 1100
        const { causeId, netUsdxMinor } = await runOnrampThroughReserve(post, merchantId);
        await post({
          kind: "onramp.settled",
          cause: { type: "fiat_event", id: causeId },
          entries: [
            leg("2000", "debit", USDX, netUsdxMinor, merchantId),
            leg("1150", "credit", USDX, netUsdxMinor),
          ],
        });

        let remainingRefundable = BigInt(netUsdxMinor); // 99000000 — the on-chain settled amount

        async function partialRefund(
          refundUsd: string,
        ): Promise<{ reclaimed: string; shortfallUsd: string }> {
          const { amount: requested } = convert(refundUsd, USD_DECIMALS, USDX_DECIMALS, ONE, ONE);
          const reclaimed = (
            BigInt(requested) < remainingRefundable ? BigInt(requested) : remainingRefundable
          ).toString();
          remainingRefundable -= BigInt(reclaimed);

          const { amount: reclaimedUsd } = convert(
            reclaimed,
            USDX_DECIMALS,
            USD_DECIMALS,
            ONE,
            ONE,
          );
          const shortfallUsd = (BigInt(refundUsd) - BigInt(reclaimedUsd)).toString();

          const refundCauseId = `${RUN_PREFIX}-partial-refund-${randomUUID()}`;
          await post({
            kind: "refund.chain_reversed",
            cause: { type: "fiat_event", id: refundCauseId },
            entries: [
              leg("1100", "debit", USDX, reclaimed),
              leg("1810", "credit", USDX, reclaimed),
            ],
          });

          const fiatLegs: PostingLeg[] = [
            leg("1800", "debit", USD, reclaimedUsd),
            leg("1000", "credit", USD, refundUsd),
          ];
          if (BigInt(shortfallUsd) > 0n) {
            fiatLegs.push(leg("1300", "debit", USD, shortfallUsd, merchantId));
          }
          await post({
            kind: "refund.fiat_returned",
            cause: { type: "fiat_event", id: refundCauseId },
            entries: fiatLegs,
          });

          return { reclaimed, shortfallUsd };
        }

        const first = await partialRefund("5000");
        expect(first.reclaimed).toBe("50000000");
        expect(first.shortfallUsd).toBe("0");
        // A zero shortfall must never reach 1300 — LedgerService.assertPostable rejects a
        // zero-amount leg, and posting one anyway would be a phantom debt entry for money that was
        // never owed.
        expect(await signedBalance(queryRunner, "1300", USD, "merchant", merchantId)).toBe(0n);

        const second = await partialRefund("5000");
        expect(second.reclaimed).toBe("49000000"); // capped: only 49 USDX left refundable
        expect(second.shortfallUsd).toBe("100"); // $1 debt — the uncovered fee-equivalent

        expect(await signedBalance(queryRunner, "1300", USD, "merchant", merchantId)).toBe(100n);
        expect(remainingRefundable).toBe(0n);

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });

    it("accepts a refund.chain_reversed unrelated to any settlement — the refund cap is not a ledger guarantee (ADR-0018 boundary)", async () => {
      // ADR-0018 says reclaimed tokens are "capped at the payment's remaining on-chain refundable
      // amount". refund.chain_reversed's two legs are DR 1100 / CR 1810 — neither leg names the
      // merchant, the payment, or any prior settlement. LedgerService only checks that a posting
      // balances and that no allows_negative=false account goes negative; 1810 allows_negative=true,
      // so this passes with no upstream on-ramp at all. The cap is a saga's job that does not exist
      // yet (Block 8.x) — the ledger provides no backstop, unlike the float check (1100) which the
      // database itself enforces. This is a documented intention, not a constraint.
      //
      // Proved inside a transaction that is rolled back, never committed: 1100 is a shared platform
      // account, and a committed phantom reclaim this large would permanently inflate it for every
      // later spec file. SET CONSTRAINTS ALL IMMEDIATE runs the deferred balance/non-negative
      // trigger now, so a successful statement is exactly the verdict COMMIT would have given.
      const phantomAmount = "999999999999"; // enormous — no payment anywhere ever settled this
      const causeId = `${RUN_PREFIX}-phantom-refund-${randomUUID()}`;
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        await ledger.post(
          {
            kind: "refund.chain_reversed",
            cause: { type: "fiat_event", id: causeId },
            entries: [
              leg("1100", "debit", USDX, phantomAmount),
              leg("1810", "credit", USDX, phantomAmount),
            ],
          },
          queryRunner,
        );

        // Resolves rather than raising: the trigger accepts it. If a later change adds a
        // payment-scoped cap below the saga, this is exactly the assertion that should start
        // failing.
        await expect(queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE")).resolves.toBeDefined();
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }

      expect(await headerExists(dataSource, "refund.chain_reversed", "fiat_event", causeId)).toBe(
        false,
      );
    });
  });

  describe("payout — the merchant's tokens, burned, then fiat", () => {
    it("payout.burned journals a residual to 3900 for a non-exact rate, then payout.settled and payout.returned move 2010/1010 together", async () => {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const { post, postedTransactionIds } = makePoster(queryRunner);
        const merchantId = randomUUID();
        // 99.000050 USDX pays $99.00 exactly — the residual the ADR names by number.
        const burnAmount = "99000050";
        const mintCauseId = `${RUN_PREFIX}-mint-for-burn-${randomUUID()}`;

        // Fund 2500 so the burn (a debit) never risks taking it negative regardless of the shared
        // database's history.
        await post({
          kind: "treasury.mint",
          cause: { type: "treasury_event", id: mintCauseId },
          entries: [
            leg("1100", "debit", USDX, burnAmount),
            leg("2500", "credit", USDX, burnAmount),
          ],
        });

        const { amount: converted, residual } = convert(
          burnAmount,
          USDX_DECIMALS,
          USD_DECIMALS,
          ONE,
          ONE,
        );
        expect(converted).toBe("9900");
        expect(residual).toBe("50");
        const consumed = (BigInt(burnAmount) - BigInt(residual)).toString();

        const before2500 = await signedBalance(queryRunner, "2500", USDX);
        const before1810 = await signedBalance(queryRunner, "1810", USDX);
        const before3900 = await signedBalance(queryRunner, "3900", USDX);
        const before1800 = await signedBalance(queryRunner, "1800", USD);

        const payoutCauseId = `${RUN_PREFIX}-payout-${randomUUID()}`;
        await post({
          kind: "payout.burned",
          cause: { type: "chain_event", id: payoutCauseId },
          entries: [
            leg("2500", "debit", USDX, burnAmount),
            leg("1810", "credit", USDX, consumed),
            leg("3900", "credit", USDX, residual),
            leg("1800", "debit", USD, converted),
            leg("2010", "credit", USD, converted, merchantId),
          ],
        });

        expect((await signedBalance(queryRunner, "2500", USDX)) - before2500).toBe(
          -BigInt(burnAmount),
        );
        expect((await signedBalance(queryRunner, "1810", USDX)) - before1810).toBe(
          -BigInt(consumed),
        );
        expect((await signedBalance(queryRunner, "3900", USDX)) - before3900).toBe(
          BigInt(residual),
        );
        expect((await signedBalance(queryRunner, "1800", USD)) - before1800).toBe(
          BigInt(converted),
        );
        expect(await signedBalance(queryRunner, "2010", USD, "merchant", merchantId)).toBe(
          BigInt(converted),
        );
        // I3, scoped to this transaction: 2500 minted `burnAmount` then burned exactly `burnAmount`
        // — its net delta across the whole scenario is zero.
        expect(
          (await signedBalance(queryRunner, "2500", USDX)) - before2500 + BigInt(burnAmount),
        ).toBe(0n);

        // payout.settled draws DOWN 1010 (a credit, on a debit-normal account) — ADR-0018's own
        // words are "without [treasury.psp_sweep] 1010 could never hold the cash a fiat payout
        // draws on". Fund 1000 first so the sweep itself never overdraws it, then fund 1010 here,
        // isolated to exactly this payout's amount.
        await fundCashFloat(post, converted);
        await post({
          kind: "treasury.psp_sweep",
          cause: { type: "treasury_event", id: `${RUN_PREFIX}-sweep-for-${payoutCauseId}` },
          entries: [leg("1010", "debit", USD, converted), leg("1000", "credit", USD, converted)],
        });

        const before1010 = await signedBalance(queryRunner, "1010", USD);
        await post({
          kind: "payout.settled",
          cause: { type: "chain_event", id: payoutCauseId },
          entries: [
            leg("2010", "debit", USD, converted, merchantId),
            leg("1010", "credit", USD, converted),
          ],
        });
        expect(await signedBalance(queryRunner, "2010", USD, "merchant", merchantId)).toBe(0n);
        expect((await signedBalance(queryRunner, "1010", USD)) - before1010).toBe(
          -BigInt(converted),
        );

        // The ACH/SEPA payout bounces — payout.returned reopens the obligation (failure mode A16).
        await post({
          kind: "payout.returned",
          cause: { type: "chain_event", id: payoutCauseId },
          entries: [
            leg("1010", "debit", USD, converted),
            leg("2010", "credit", USD, converted, merchantId),
          ],
        });
        expect(await signedBalance(queryRunner, "2010", USD, "merchant", merchantId)).toBe(
          BigInt(converted),
        );
        expect(await signedBalance(queryRunner, "1010", USD)).toBe(before1010); // net zero after settle + bounce

        await queryRunner.query("SET CONSTRAINTS ALL IMMEDIATE");
        await assertTrialBalance(queryRunner, postedTransactionIds);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });
  });

  describe("Category 4 — cross-asset mismatch on the ADR's new merchant account codes", () => {
    it("rejects 2200 (frozen_payable, USDX-only) named in USD, and creates no account row", async () => {
      const merchantId = randomUUID();
      const causeId = `${RUN_PREFIX}-mismatch-2200-${randomUUID()}`;
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        await expect(
          ledger.post(
            {
              kind: "compliance.frozen",
              cause: { type: "compliance_event", id: causeId },
              entries: [
                leg("1000", "debit", USD, "100"),
                leg("2200", "credit", USD, "100", merchantId),
              ],
            },
            queryRunner,
          ),
        ).rejects.toThrow(/2200.*USDX.*not USD/i);
      } finally {
        // The mismatch is a synchronous validation thrown AFTER the header insert but BEFORE any
        // ledger_entries insert — so mid-transaction the header is visible to this same connection.
        // What matters is that nothing survives the rollback, so check via `dataSource` (a separate,
        // real-committed-state connection) only after this transaction is gone.
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }

      const accounts = await dataSource.query<{ id: string }[]>(
        `SELECT id FROM ledger_accounts WHERE code = '2200' AND owner_id = $1`,
        [merchantId],
      );
      expect(accounts).toHaveLength(0);
      expect(await headerExists(dataSource, "compliance.frozen", "compliance_event", causeId)).toBe(
        false,
      );
    });

    it("rejects 2010 (merchant_fiat_payable, USD-only) named in USDX, and creates no account row", async () => {
      const merchantId = randomUUID();
      const causeId = `${RUN_PREFIX}-mismatch-2010-${randomUUID()}`;
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        await expect(
          ledger.post(
            {
              kind: "payout.burned",
              cause: { type: "chain_event", id: causeId },
              entries: [
                leg("1810", "debit", USDX, "100"),
                leg("2010", "credit", USDX, "100", merchantId),
              ],
            },
            queryRunner,
          ),
        ).rejects.toThrow(/2010.*USD.*not USDX/i);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }

      const accounts = await dataSource.query<{ id: string }[]>(
        `SELECT id FROM ledger_accounts WHERE code = '2010' AND owner_id = $1`,
        [merchantId],
      );
      expect(accounts).toHaveLength(0);
      expect(await headerExists(dataSource, "payout.burned", "chain_event", causeId)).toBe(false);
    });
  });

  describe("no residue", () => {
    it("commits nothing: every cause id this file generated has zero rows in ledger_transactions", async () => {
      // Every test above rolled its own transaction back, so this must be zero regardless of how
      // many scenarios ran or in what order — a regression here (a stray `queryRunner.commitTransaction()`,
      // or a code path that opens its own connection instead of joining the caller's) would show up
      // as a nonzero count, not as an individual test failure.
      const rows = await dataSource.query<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM ledger_transactions WHERE cause_id LIKE $1`,
        [`${RUN_PREFIX}%`],
      );
      expect(Number(rows[0]?.count ?? "0")).toBe(0);
    });
  });
});
