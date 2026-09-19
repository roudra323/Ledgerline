import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource } from "typeorm";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingRequest } from "../src/ledger/ledger.types";
import { MetricsService } from "../src/observability/metrics.service";

/**
 * `ledger-join-transaction.integration-spec.ts` was written by the same agent that wrote
 * `post(request, joinTransaction)` and its `EntityManager` threading. It proves the two scenarios
 * that agent already had in mind (commit-with-the-caller, rollback-with-the-caller). This file
 * goes looking for what it didn't: multiple postings sharing one caller transaction, a caller
 * transaction that is already aborted, a caller that does further work after a successful post()
 * and then fails, callers that misuse the QueryRunner contract, and whether `alreadyPosted`
 * behaves correctly when the ONLY committed copy of a cause belongs to a different transaction
 * than the one currently observing it.
 */
describe("LedgerService.post() joining a caller's transaction — adversarial", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;

  beforeAll(async () => {
    dataSource = new DataSource(appDataSourceOptions);
    await dataSource.initialize();
    ledger = new LedgerService(
      dataSource,
      new AccountRegistryService(dataSource.getRepository(LedgerAccount)),
      new MetricsService(
        new Counter({
          name: "ledgerline_ledger_entries_written_total",
          help: "test",
          labelNames: ["kind"],
          registers: [new Registry()],
        }),
      ),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  function simpleRequest(causeId: string): PostingRequest {
    return {
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "100" },
      ],
    };
  }

  async function countTransactions(causeId: string): Promise<number> {
    const rows = await dataSource.query<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM ledger_transactions WHERE cause_id = $1`,
      [causeId],
    );
    return Number(rows[0]?.count ?? "0");
  }

  it("posts TWICE into one caller transaction — both survive the same commit, distinctly", async () => {
    const causeA = `evt_${randomUUID()}`;
    const causeB = `evt_${randomUUID()}`;

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const resultA = await ledger.post(simpleRequest(causeA), queryRunner);
    const resultB = await ledger.post(simpleRequest(causeB), queryRunner);
    expect(resultA.transactionId).not.toBe(resultB.transactionId);

    await queryRunner.commitTransaction();
    await queryRunner.release();

    expect(await countTransactions(causeA)).toBe(1);
    expect(await countTransactions(causeB)).toBe(1);
  });

  it("re-posting the SAME cause on the SAME still-open caller transaction is idempotent before commit", async () => {
    // Probes the insertTransactionHeader docstring's isolation-level caveat from the inside: the
    // re-SELECT after a conflicting INSERT must see the row this very transaction already
    // inserted, not just a different transaction's committed row — same-session visibility, not
    // cross-session visibility.
    const causeId = `evt_${randomUUID()}`;
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const first = await ledger.post(simpleRequest(causeId), queryRunner);
    const second = await ledger.post(simpleRequest(causeId), queryRunner);

    expect(first.alreadyPosted).toBe(false);
    expect(second.alreadyPosted).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    await queryRunner.commitTransaction();
    await queryRunner.release();

    expect(await countTransactions(causeId)).toBe(1);
  });

  it("joining an already-aborted transaction fails loudly instead of silently succeeding or hanging", async () => {
    const causeId = `evt_${randomUUID()}`;
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // Abort the transaction ourselves, the way a caller's own bug (an unrelated bad statement
    // earlier in its saga) would: Postgres marks the whole transaction unusable until it ends.
    await expect(queryRunner.query("SELECT 1/0")).rejects.toThrow();

    await expect(ledger.post(simpleRequest(causeId), queryRunner)).rejects.toThrow(
      /current transaction is aborted/i,
    );

    await queryRunner.rollbackTransaction();
    await queryRunner.release();
    expect(await countTransactions(causeId)).toBe(0);
  });

  it("caller does further work AFTER a successful join-post and that work fails — the posting is rolled back too", async () => {
    const causeId = `evt_${randomUUID()}`;
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    await ledger.post(simpleRequest(causeId), queryRunner);

    // Simulate the caller's OWN later step failing — e.g. a saga writing its own state — well
    // after post() returned successfully.
    await expect(
      queryRunner.query("INSERT INTO no_such_table_at_all (x) VALUES (1)"),
    ).rejects.toThrow();

    await queryRunner.rollbackTransaction();
    await queryRunner.release();

    // A saga's own failure after a successful post() must not leave the posting half-committed:
    // this is the whole reason joinTransaction exists in the first place.
    expect(await countTransactions(causeId)).toBe(0);
  });

  it("rejects a QueryRunner that was only connect()-ed, never startTransaction()-ed", async () => {
    // Was a real atomicity hole. post() with joinTransaction never calls startTransaction() itself
    // — it trusts the caller already did. If the caller forgot, every queryRunner.query() inside
    // post() ran as its OWN implicit autocommitted transaction, so the deferred balance trigger
    // fired after each INSERT instead of once at the end. The header committed for real, then the
    // first leg was, on its own, a one-legged unbalanced transaction and was rejected — leaving an
    // orphaned ledger_transactions row with zero entries that the immutability trigger then makes
    // permanent. Exactly the half-written, un-derivable state the append-only design exists to
    // make impossible.
    //
    // Fixed 2026-09-06: post() now checks isTransactionActive and refuses. This test locks in the
    // rejection AND asserts nothing was written, since a guard that throws after writing the header
    // would look identical from the caller's side.
    const causeId = `evt_${randomUUID()}`;
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect(); // deliberately no startTransaction()

    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "100" },
      ],
    };

    await expect(ledger.post(request, queryRunner)).rejects.toThrow(/no active transaction/i);
    await queryRunner.release();

    const rows = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_transactions WHERE cause_id = $1`,
      [causeId],
    );
    expect(rows).toHaveLength(0);
  });

  it("alreadyPosted, observed inside a transaction that later rolls back, still reflects a real, unaffected commit", async () => {
    const causeId = `evt_${randomUUID()}`;

    // The cause is posted and committed for real, on its own, first — this is the "outer
    // transaction" that actually owns the row.
    const original = await ledger.post(simpleRequest(causeId));
    expect(original.alreadyPosted).toBe(false);

    // A second, unrelated transaction later observes the same cause via joinTransaction, correctly
    // gets alreadyPosted: true, and then rolls back for a reason that has nothing to do with the
    // posting (e.g. a downstream step in the same saga failed).
    const observerRunner = dataSource.createQueryRunner();
    await observerRunner.connect();
    await observerRunner.startTransaction();
    const observed = await ledger.post(simpleRequest(causeId), observerRunner);
    expect(observed.alreadyPosted).toBe(true);
    expect(observed.transactionId).toBe(original.transactionId);
    await observerRunner.rollbackTransaction();
    await observerRunner.release();

    // The original, already-committed posting must be completely unaffected by the observer's
    // rollback: still exactly one row, same id.
    expect(await countTransactions(causeId)).toBe(1);
    const rows = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_transactions WHERE cause_id = $1`,
      [causeId],
    );
    expect(rows[0]?.id).toBe(original.transactionId);
  });

  it("a QueryRunner passed without even connect() being called fails clearly rather than hanging", async () => {
    const causeId = `evt_${randomUUID()}`;
    const queryRunner = dataSource.createQueryRunner(); // no connect(), no startTransaction()

    await expect(ledger.post(simpleRequest(causeId), queryRunner)).rejects.toThrow();
  });
});
