import type { DataSource } from "typeorm";

import type { AccountRegistryService } from "./account-registry.service";
import { LedgerService } from "./ledger.service";
import type { PostingRequest } from "./ledger.types";

/**
 * Unit tests for the TypeScript-side validation LedgerService.post() runs before touching the
 * database — see docs/learning-path.md Block 1.6 for why this mirrors, but doesn't replace, the
 * Block 1.4 database trigger.
 */
describe("LedgerService.post() validation", () => {
  function buildService(): LedgerService {
    const dataSource = {
      createQueryRunner: () => {
        throw new Error("createQueryRunner should never be called for an invalid posting");
      },
    } as unknown as DataSource;
    const accounts = {} as AccountRegistryService;
    return new LedgerService(dataSource, accounts);
  }

  const platformDebitUsd = { accountCode: "1000", direction: "debit" as const, assetCode: "USD" as const };
  const platformCreditUsd = { accountCode: "2100", direction: "credit" as const, assetCode: "USD" as const };

  it("rejects a posting with fewer than two entries", async () => {
    const service = buildService();
    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "test", id: "1" },
      entries: [{ ...platformDebitUsd, amountMinor: "100" }],
    };

    await expect(service.post(request)).rejects.toThrow(/at least 2 entries/);
  });

  it("rejects a non-positive amount", async () => {
    const service = buildService();
    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "test", id: "2" },
      entries: [
        { ...platformDebitUsd, amountMinor: "0" },
        { ...platformCreditUsd, amountMinor: "100" },
      ],
    };

    await expect(service.post(request)).rejects.toThrow(/must be positive/);
  });

  it("rejects an unbalanced posting", async () => {
    const service = buildService();
    const request: PostingRequest = {
      kind: "onramp.capture",
      cause: { type: "test", id: "3" },
      entries: [
        { ...platformDebitUsd, amountMinor: "100" },
        { ...platformCreditUsd, amountMinor: "50" },
      ],
    };

    await expect(service.post(request)).rejects.toThrow(/unbalanced in USD/);
  });

  it("treats different asset codes as independent balance groups", async () => {
    const service = buildService();
    const request: PostingRequest = {
      kind: "onramp.settled",
      cause: { type: "test", id: "4" },
      entries: [
        { ...platformDebitUsd, amountMinor: "1000" },
        { ...platformCreditUsd, amountMinor: "1000" },
        { accountCode: "1810", direction: "debit", assetCode: "USDX", amountMinor: "9000000" },
        // Missing the USDX credit leg on purpose — USD balances, USDX doesn't.
      ],
    };

    await expect(service.post(request)).rejects.toThrow(/unbalanced in USDX/);
  });
});
