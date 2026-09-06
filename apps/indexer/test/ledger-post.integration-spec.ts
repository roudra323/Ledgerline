import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource } from "typeorm";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerService } from "../src/ledger/ledger.service";
import { MetricsService } from "../src/observability/metrics.service";
import type { PostingRequest } from "../src/ledger/ledger.types";

/**
 * Proves LedgerService.post() (Block 1.6) end to end: it posts a balanced transaction, it is
 * idempotent per (kind, cause_type, cause_id), and it resolves both platform and per-merchant
 * account codes. Connects as the least-privilege app role (Block 1.5) — the same connection the
 * running app actually uses.
 */
describe("LedgerService.post()", () => {
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

  async function entriesFor(
    transactionId: string,
  ): Promise<{ direction: string; amount_minor: string }[]> {
    return dataSource.query(
      `SELECT direction, amount_minor FROM ledger_entries WHERE transaction_id = $1 ORDER BY sequence`,
      [transactionId],
    );
  }

  it("posts a balanced transaction and the entries are readable back", async () => {
    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: `evt_${randomUUID()}` },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "10000" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "10000" },
      ],
    };

    const result = await ledger.post(request);
    expect(result.alreadyPosted).toBe(false);

    const entries = await entriesFor(result.transactionId);
    expect(entries).toEqual([
      { direction: "debit", amount_minor: "10000" },
      { direction: "credit", amount_minor: "10000" },
    ]);
  });

  it("posting the same cause twice is idempotent — one transaction, entries not duplicated", async () => {
    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: `evt_${randomUUID()}` },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "500" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "500" },
      ],
    };

    const first = await ledger.post(request);
    const second = await ledger.post(request);

    expect(first.alreadyPosted).toBe(false);
    expect(second.alreadyPosted).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const entries = await entriesFor(first.transactionId);
    expect(entries).toHaveLength(2);
  });

  it("creates a per-merchant account on first use and reuses it on the next posting", async () => {
    const merchantId = randomUUID();
    const request = (causeId: string): PostingRequest => ({
      kind: "onramp.settled",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        { accountCode: "1100", direction: "debit", assetCode: "USDX", amountMinor: "7000000" },
        {
          accountCode: "2000",
          direction: "credit",
          assetCode: "USDX",
          amountMinor: "7000000",
          merchantId,
        },
      ],
    });

    await ledger.post(request(`evt_${randomUUID()}`));
    await ledger.post(request(`evt_${randomUUID()}`));

    const merchantAccounts = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_accounts WHERE code = '2000' AND owner_type = 'merchant' AND owner_id = $1`,
      [merchantId],
    );
    expect(merchantAccounts).toHaveLength(1);
  });

  it("rejects an unbalanced posting before ever reaching the database", async () => {
    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "fiat_event", id: `evt_${randomUUID()}` },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "50" },
      ],
    };

    await expect(ledger.post(request)).rejects.toThrow(/unbalanced/i);

    const rows = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_transactions WHERE cause_type = 'fiat_event' AND cause_id = $1`,
      [request.cause.id],
    );
    expect(rows).toHaveLength(0);
  });
});
