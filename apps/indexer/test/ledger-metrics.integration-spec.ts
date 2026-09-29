import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource } from "typeorm";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingRequest } from "../src/ledger/ledger.types";
import { LEDGER_ENTRIES_WRITTEN, MetricsService } from "../src/observability/metrics.service";

/**
 * MetricsService.recordLedgerEntriesWritten's docstring claims it is "[c]alled only when a
 * posting really wrote" and that a redelivered cause resolving to `alreadyPosted` "inserts
 * nothing, and counting it would overstate ledger activity". This proves that claim against a
 * real LedgerService + real database, not by trusting the comment.
 */
describe("ledger entries written metric — real post() against a real database", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;
  let counter: Counter<"kind">;

  beforeAll(async () => {
    dataSource = new DataSource(appDataSourceOptions);
    await dataSource.initialize();
    const accounts = new AccountRegistryService(dataSource.getRepository(LedgerAccount));
    counter = new Counter({
      name: LEDGER_ENTRIES_WRITTEN,
      help: "test",
      labelNames: ["kind"],
      registers: [new Registry()],
    });
    ledger = new LedgerService(
      dataSource,
      accounts,
      new MetricsService(
        counter,
        new Counter({
          name: "ledgerline_ledger_postings_rejected_total",
          help: "test",
          labelNames: ["kind", "reason_class"],
          registers: [new Registry()],
        }),
      ),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function seriesValueFor(kind: string): Promise<number> {
    const metric = await counter.get();
    return metric.values.find((value) => value.labels.kind === kind)?.value ?? 0;
  }

  it("increments by the number of entries actually written, labelled by kind", async () => {
    const kind = "onramp.capture";
    const before = await seriesValueFor(kind);

    const request: PostingRequest = {
      kind,
      cause: { type: "fiat_event", id: `evt_${randomUUID()}` },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "100" },
      ],
    };

    await ledger.post(request);

    expect(await seriesValueFor(kind)).toBe(before + 2);
  });

  it("does NOT increment when the cause was already posted (alreadyPosted: true)", async () => {
    const kind = "onramp.capture";
    const request: PostingRequest = {
      kind,
      cause: { type: "fiat_event", id: `evt_${randomUUID()}` },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "250" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "250" },
      ],
    };

    const first = await ledger.post(request);
    expect(first.alreadyPosted).toBe(false);
    const afterFirstPost = await seriesValueFor(kind);

    const second = await ledger.post(request);
    expect(second.alreadyPosted).toBe(true);

    // The regression this test catches: a naive implementation that records the metric based on
    // `request.entries.length` unconditionally, rather than gating on `alreadyPosted`, would
    // double-count every webhook redelivery and mask a real throughput drop behind retry noise.
    expect(await seriesValueFor(kind)).toBe(afterFirstPost);
  });

  it("never attaches a merchant id or any label besides 'kind', even for a merchant posting", async () => {
    const merchantId = randomUUID();
    const kind = "onramp.settled";
    const request: PostingRequest = {
      kind,
      cause: { type: "fiat_event", id: `evt_${randomUUID()}` },
      entries: [
        { accountCode: "1100", direction: "debit", assetCode: "USDX", amountMinor: "1000" },
        {
          accountCode: "2000",
          direction: "credit",
          assetCode: "USDX",
          amountMinor: "1000",
          merchantId,
        },
      ],
    };

    await ledger.post(request);

    const metric = await counter.get();
    const series = metric.values.find((value) => value.labels.kind === kind);
    expect(series).toBeDefined();
    expect(Object.keys(series?.labels ?? {})).toEqual(["kind"]);
    // Belt and braces: the merchant id must not appear anywhere in the label values either.
    expect(Object.values(series?.labels ?? {})).not.toContain(merchantId);
  });
});
