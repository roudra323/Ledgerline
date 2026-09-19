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
 * `PostingRequest.postedAt`'s docstring: "Omit on the live path and the database default (now())
 * applies; a replay MUST supply the original time, or rebuilt history is stamped with the
 * replay's clock and Part 4's replay-determinism deep-equal fails." This proves that claim, and
 * probes what happens when a caller supplies a hostile value instead of a well-formed past date.
 */
describe("PostingRequest.postedAt threading", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;

  beforeAll(async () => {
    dataSource = new DataSource(appDataSourceOptions);
    await dataSource.initialize();
    const accounts = new AccountRegistryService(dataSource.getRepository(LedgerAccount));
    const metrics = new MetricsService(
      new Counter({
        name: "ledgerline_ledger_entries_written_total",
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

  function twoLegRequest(causeId: string, postedAt?: Date): PostingRequest {
    return {
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "100" },
      ],
      ...(postedAt ? { postedAt } : {}),
    };
  }

  async function postedAtFor(transactionId: string): Promise<Date> {
    const rows = await dataSource.query<{ posted_at: Date }[]>(
      `SELECT posted_at FROM ledger_transactions WHERE id = $1`,
      [transactionId],
    );
    const row = rows[0];
    if (!row) throw new Error(`no ledger_transactions row for id ${transactionId}`);
    return row.posted_at;
  }

  it("stores the caller-supplied postedAt exactly, for a replay backdating a past event", async () => {
    const replayTime = new Date("2020-01-15T12:00:00.000Z");
    const request = twoLegRequest(`evt_${randomUUID()}`, replayTime);

    const result = await ledger.post(request);
    const stored = await postedAtFor(result.transactionId);

    expect(stored.toISOString()).toBe(replayTime.toISOString());
  });

  it("applies the database default (now()) when postedAt is omitted on the live path", async () => {
    const before = Date.now();
    const request = twoLegRequest(`evt_${randomUUID()}`);

    const result = await ledger.post(request);
    const stored = await postedAtFor(result.transactionId);
    const after = Date.now();

    // Not equal to any fixed past date, and within the wall-clock window the call actually ran in.
    expect(stored.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("hostile: an invalid Date is rejected rather than silently stored as garbage or as now()", async () => {
    const invalidDate = new Date("not-a-real-date");
    expect(Number.isNaN(invalidDate.getTime())).toBe(true);
    const request = twoLegRequest(`evt_${randomUUID()}`, invalidDate);

    // Whatever the failure mode, it must be a rejection, not a silent, wrong write: either the
    // driver throws serializing the invalid Date, or Postgres rejects the resulting value. A
    // regression that instead coerces this into NaN/epoch/now() and commits it would slip past
    // any test that only checks "post() succeeded".
    await expect(ledger.post(request)).rejects.toThrow();

    const rows = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_transactions WHERE cause_type = 'fiat_event' AND cause_id = $1`,
      [request.cause.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("hostile: a far-future postedAt is accepted verbatim — nothing in post() bounds it to 'now or earlier'", async () => {
    // This is a finding, not a claim being defended: postedAt has no upper-bound check anywhere on
    // this path, so a caller bug (or a maliciously/incorrectly replayed event) can backdate — or
    // "forward-date" — a posting arbitrarily into the future with no rejection. Pinned here so a
    // future fix that adds a bound has a test to flip, and so this gap is documented in a way that
    // survives past a comment.
    const farFuture = new Date("2999-01-01T00:00:00.000Z");
    const request = twoLegRequest(`evt_${randomUUID()}`, farFuture);

    const result = await ledger.post(request);
    const stored = await postedAtFor(result.transactionId);

    expect(stored.toISOString()).toBe(farFuture.toISOString());
  });
});
