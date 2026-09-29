import { Counter, Registry } from "prom-client";
import type { DataSource } from "typeorm";

import { MetricsService } from "../observability/metrics.service";

import type { AccountRegistryService } from "./account-registry.service";
import { LedgerRejectionError, LedgerUnbalancedError } from "./ledger-errors";
import { LedgerService } from "./ledger.service";
import type { PostingRequest } from "./ledger.types";

/**
 * `ledger.service.spec.ts` proves the TypeScript pre-check's unbalanced rejection *by message*
 * (`/unbalanced in USD/`). ADR-0019 promises more than a message: the rejection must be a typed
 * `LedgerUnbalancedError`, because that is what `recordRejection()` uses to decide whether to
 * increment `ledgerline_ledger_postings_rejected_total` at all — a plain `Error` here would
 * silently stop being counted.
 */
describe("LedgerService.post() — typed pre-check rejection (ADR-0019)", () => {
  function buildService(): {
    service: LedgerService;
    rejectedCounter: Counter<"kind" | "reason_class">;
  } {
    const rejectedCounter = new Counter({
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
    const dataSource = {
      createQueryRunner: () => {
        throw new Error("createQueryRunner should never be called for an invalid posting");
      },
    } as unknown as DataSource;
    const accounts = {} as AccountRegistryService;
    return { service: new LedgerService(dataSource, accounts, metrics), rejectedCounter };
  }

  it("throws a LedgerUnbalancedError instance, not a bare Error, for an unbalanced posting", async () => {
    const { service } = buildService();
    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "test", id: "unbalanced-1" },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "50" },
      ],
    };

    let caught: unknown;
    try {
      await service.post(request);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LedgerUnbalancedError);
    expect(caught).toBeInstanceOf(LedgerRejectionError);
  });

  it("counts the typed pre-check rejection under reason_class=unbalanced for that posting's kind", async () => {
    const { service, rejectedCounter } = buildService();
    const request: PostingRequest = {
      kind: "onramp.fx",
      cause: { type: "test", id: "unbalanced-2" },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "50" },
      ],
    };

    await expect(service.post(request)).rejects.toBeInstanceOf(LedgerUnbalancedError);

    const metric = await rejectedCounter.get();
    const series = metric.values.find(
      (value) => value.labels.kind === "onramp.fx" && value.labels.reason_class === "unbalanced",
    );
    expect(series?.value).toBe(1);
  });

  it("does NOT count a plain (non-typed) pre-check rejection, e.g. too few legs", async () => {
    // assertPostable() throws a bare Error (not a LedgerRejectionError) for "fewer than 2 legs" —
    // recordRejection() must not miscount that as a typed reason_class.
    const { service, rejectedCounter } = buildService();
    const request: PostingRequest = {
      kind: "onramp.reserve",
      cause: { type: "test", id: "too-few-legs" },
      entries: [{ accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "100" }],
    };

    await expect(service.post(request)).rejects.toThrow(/at least 2 entries/);

    const metric = await rejectedCounter.get();
    const series = metric.values.find((value) => value.labels.kind === "onramp.reserve");
    expect(series).toBeUndefined();
  });
});
