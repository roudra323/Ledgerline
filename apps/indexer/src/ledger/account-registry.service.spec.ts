import type { Repository } from "typeorm";

import { AccountRegistryService } from "./account-registry.service";
import type { LedgerAccount } from "./entities/ledger-account.entity";

/**
 * `MERCHANT_ACCOUNT_DEFINITIONS` pins each merchant account code to exactly one asset (2000 is
 * `USDX`, per docs/architecture.md §3.3), and `createMerchantAccount` throws when a caller asks
 * for it in a different asset. This proves the rejection fires, AND — the more important half —
 * that it fires strictly before any database write is attempted: a `Repository` stub whose
 * `query`/`insert`/`save` methods throw if called stands in for the database here, so this test
 * would fail loudly if a future change moved the asset check to run *after* the INSERT.
 */
describe("AccountRegistryService — merchant account / asset mismatch", () => {
  function repositoryThatMustNeverBeWrittenTo(): Repository<LedgerAccount> {
    return {
      findOne: () => Promise.resolve(null),
      query: () => {
        throw new Error("repository.query() should never be called for a mismatched asset");
      },
      insert: () => {
        throw new Error("repository.insert() should never be called for a mismatched asset");
      },
      save: () => {
        throw new Error("repository.save() should never be called for a mismatched asset");
      },
    } as unknown as Repository<LedgerAccount>;
  }

  it("rejects resolveMerchantAccount('2000', 'USD', ...) — 2000 is denominated in USDX", async () => {
    const repository = repositoryThatMustNeverBeWrittenTo();
    const registry = new AccountRegistryService(repository);

    await expect(registry.resolveMerchantAccount("2000", "USD", "merchant-1")).rejects.toThrow(
      /2000.*USDX.*not USD/i,
    );
  });

  it("rejects the mismatch in the other direction too: '1300' is denominated in USD, not USDX", async () => {
    const repository = repositoryThatMustNeverBeWrittenTo();
    const registry = new AccountRegistryService(repository);

    await expect(registry.resolveMerchantAccount("1300", "USDX", "merchant-2")).rejects.toThrow(
      /1300.*USD.*not USDX/i,
    );
  });

  it("still throws for an asset mismatch on a code with no definition at all", async () => {
    const repository = repositoryThatMustNeverBeWrittenTo();
    const registry = new AccountRegistryService(repository);

    await expect(registry.resolveMerchantAccount("9999", "USD", "merchant-3")).rejects.toThrow(
      /no merchant account definition/i,
    );
  });
});
