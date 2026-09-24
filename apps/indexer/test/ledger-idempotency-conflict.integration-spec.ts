import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource } from "typeorm";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerIdempotencyConflictError } from "../src/ledger/ledger-errors";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingLeg, PostingRequest } from "../src/ledger/ledger.types";
import { MetricsService } from "../src/observability/metrics.service";

/**
 * ADR-0019: replaying an already-posted cause is a no-op ONLY when its legs describe the same
 * money movement, compared as a multiset "so the database's own casts normalise both sides —
 * `uuid` for the merchant id (case, braces) and `numeric` for the amount ('0100' = '100') — and
 * leg order does not matter". Every one of those quoted claims gets its own test here, plus the
 * genuine-mismatch path the whole mechanism exists to catch.
 */
describe("LedgerService.post() — idempotency conflict on a replayed cause (ADR-0019)", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;
  let rejectedCounter: Counter<"kind" | "reason_class">;

  beforeAll(async () => {
    dataSource = new DataSource(appDataSourceOptions);
    await dataSource.initialize();
    const accounts = new AccountRegistryService(dataSource.getRepository(LedgerAccount));
    rejectedCounter = new Counter({
      name: "ledgerline_ledger_postings_rejected_total",
      help: "test",
      labelNames: ["kind", "reason_class"],
      registers: [new Registry()],
    });
    const metrics = new MetricsService(
      new Counter({
        name: "ledgerline_ledger_entries_written_total",
        help: "test",
        labelNames: ["kind"],
        registers: [new Registry()],
      }),
      rejectedCounter,
    );
    ledger = new LedgerService(dataSource, accounts, metrics);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  function leg(
    accountCode: string,
    direction: "debit" | "credit",
    amountMinor: string,
    merchantId?: string,
    assetCode: "USD" | "USDX" = "USD",
  ): PostingLeg {
    return {
      accountCode,
      direction,
      assetCode,
      amountMinor,
      ...(merchantId !== undefined ? { merchantId } : {}),
    };
  }

  function request(
    kind: PostingRequest["kind"],
    causeId: string,
    entries: readonly PostingLeg[],
    extra: Partial<Pick<PostingRequest, "memo" | "postedAt">> = {},
  ): PostingRequest {
    return { kind, cause: { type: "test", id: causeId }, entries, ...extra };
  }

  async function rejectedCount(kind: string, reasonClass: string): Promise<number> {
    const metric = await rejectedCounter.get();
    const series = metric.values.find(
      (value) => value.labels.kind === kind && value.labels.reason_class === reasonClass,
    );
    return series?.value ?? 0;
  }

  it("a genuinely different amount on replay is a conflict, not a silent no-op", async () => {
    const kind = "chargeback.received";
    const causeId = `conflict-amount-${randomUUID()}`;
    const first = await ledger.post(
      request(kind, causeId, [leg("1000", "debit", "100"), leg("2100", "credit", "100")]),
    );
    expect(first.alreadyPosted).toBe(false);

    const replay = request(kind, causeId, [
      leg("1000", "debit", "999"),
      leg("2100", "credit", "999"),
    ]);
    await expect(ledger.post(replay)).rejects.toBeInstanceOf(LedgerIdempotencyConflictError);

    // Nothing was corrupted: still exactly the original two entries, untouched.
    const entries = await dataSource.query<{ amount_minor: string }[]>(
      `SELECT amount_minor FROM ledger_entries WHERE transaction_id = $1 ORDER BY sequence`,
      [first.transactionId],
    );
    expect(entries.map((e) => e.amount_minor)).toEqual(["100", "100"]);
    expect(await rejectedCount(kind, "idempotency_conflict")).toBe(1);
  });

  it("a replay naming a different account entirely is a conflict", async () => {
    const kind = "fx.residual";
    const causeId = `conflict-account-${randomUUID()}`;
    await ledger.post(
      request(kind, causeId, [leg("1000", "debit", "100"), leg("2100", "credit", "100")]),
    );

    const replay = request(kind, causeId, [
      leg("1010", "debit", "100"),
      leg("2100", "credit", "100"),
    ]);
    await expect(ledger.post(replay)).rejects.toBeInstanceOf(LedgerIdempotencyConflictError);
  });

  it("a replay with extra legs beyond what was actually posted is a conflict, even though the extras balance", async () => {
    const kind = "treasury.psp_sweep";
    const causeId = `conflict-extra-legs-${randomUUID()}`;
    await ledger.post(
      request(kind, causeId, [leg("1000", "debit", "100"), leg("2100", "credit", "100")]),
    );

    // Adds a second, self-balanced pair on top of the original — the WHOLE set nets to zero, so a
    // naive "does the replay balance" check would miss that the stored transaction never had these
    // extra two legs.
    const replay = request(kind, causeId, [
      leg("1000", "debit", "100"),
      leg("2100", "credit", "100"),
      leg("1010", "debit", "50"),
      leg("4000", "credit", "50"),
    ]);
    await expect(ledger.post(replay)).rejects.toBeInstanceOf(LedgerIdempotencyConflictError);
  });

  it("the SAME legs replayed in a DIFFERENT array order is NOT a conflict — leg order must not matter", async () => {
    const kind = "treasury.mint";
    const causeId = `no-conflict-order-${randomUUID()}`;
    const first = await ledger.post(
      request(kind, causeId, [leg("1000", "debit", "100"), leg("2100", "credit", "100")]),
    );

    const replay = request(kind, causeId, [
      leg("2100", "credit", "100"),
      leg("1000", "debit", "100"),
    ]);
    const second = await ledger.post(replay);

    expect(second.alreadyPosted).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await rejectedCount(kind, "idempotency_conflict")).toBe(0);
  });

  it("amount '0100' on replay is the same as '100' — the numeric cast, not a string comparison, decides sameness", async () => {
    const kind = "payout.requested";
    const causeId = `no-conflict-amount-cast-${randomUUID()}`;
    const first = await ledger.post(
      request(kind, causeId, [leg("1000", "debit", "100"), leg("2100", "credit", "100")]),
    );

    const replay = request(kind, causeId, [
      leg("1000", "debit", "0100"),
      leg("2100", "credit", "0100"),
    ]);
    const second = await ledger.post(replay);

    expect(second.alreadyPosted).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await rejectedCount(kind, "idempotency_conflict")).toBe(0);
  });

  it("a merchant id differing only in case on replay is the same merchant — the uuid cast decides sameness", async () => {
    const kind = "payout.returned";
    const causeId = `no-conflict-uuid-case-${randomUUID()}`;
    const merchantId = randomUUID();
    expect(merchantId).toBe(merchantId.toLowerCase());

    const first = await ledger.post(
      request(kind, causeId, [
        leg("1100", "debit", "5000000", undefined, "USDX"),
        leg("2000", "credit", "5000000", merchantId, "USDX"),
      ]),
    );

    const replay = request(kind, causeId, [
      leg("1100", "debit", "5000000", undefined, "USDX"),
      leg("2000", "credit", "5000000", merchantId.toUpperCase(), "USDX"),
    ]);
    const second = await ledger.post(replay);

    expect(first.alreadyPosted).toBe(false);
    expect(second.alreadyPosted).toBe(true);
    expect(await rejectedCount(kind, "idempotency_conflict")).toBe(0);
  });

  it("a different memo or postedAt on an otherwise identical replay is NOT a conflict — a live redelivery may carry a new wall-clock time", async () => {
    const kind = "refund.initiated";
    const causeId = `no-conflict-memo-${randomUUID()}`;
    const entries = [leg("1000", "debit", "100"), leg("2100", "credit", "100")];
    const first = await ledger.post(request(kind, causeId, entries, { memo: "first delivery" }));

    const replay = request(kind, causeId, entries, {
      memo: "redelivered by the webhook retrier",
      postedAt: new Date("2020-01-01T00:00:00Z"),
    });
    const second = await ledger.post(replay);

    expect(second.alreadyPosted).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await rejectedCount(kind, "idempotency_conflict")).toBe(0);
  });

  it("a conflicting replay inside a joined transaction is rejected AND counted (it is not a deferred trigger failure)", async () => {
    // Unlike a trigger rejection (which fires at the CALLER's commit and is deliberately uncounted
    // by post()), assertSameLegsAsPosted() runs synchronously inside write() on both paths — so
    // this one must still increment the metric even when joinTransaction is used.
    const kind = "refund.chain_reversed";
    const causeId = `conflict-joined-${randomUUID()}`;
    await ledger.post(
      request(kind, causeId, [leg("1000", "debit", "100"), leg("2100", "credit", "100")]),
    );

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const replay = request(kind, causeId, [
        leg("1000", "debit", "777"),
        leg("2100", "credit", "777"),
      ]);
      await expect(ledger.post(replay, queryRunner)).rejects.toBeInstanceOf(
        LedgerIdempotencyConflictError,
      );
    } finally {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      await queryRunner.release();
    }

    expect(await rejectedCount(kind, "idempotency_conflict")).toBe(1);
  });
});
