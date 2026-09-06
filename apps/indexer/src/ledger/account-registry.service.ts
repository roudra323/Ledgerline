import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import type { AssetCode } from "@ledgerline/shared";

import { LedgerAccount, type AccountType, type NormalSide } from "./entities/ledger-account.entity";

interface MerchantAccountDefinition {
  readonly name: string;
  readonly accountType: AccountType;
  readonly normalSide: NormalSide;
}

/**
 * Per-merchant account codes and the row shape AccountRegistryService creates on demand.
 * Mirrors the platform chart of accounts in docs/architecture.md's account table.
 */
const MERCHANT_ACCOUNT_DEFINITIONS: Readonly<Record<string, MerchantAccountDefinition>> = {
  "1300": { name: "merchant_receivable", accountType: "asset", normalSide: "debit" },
  "2000": { name: "merchant_payable", accountType: "liability", normalSide: "credit" },
  "2010": { name: "merchant_fiat_payable", accountType: "liability", normalSide: "credit" },
  "2200": { name: "frozen_payable", accountType: "liability", normalSide: "credit" },
};

/**
 * Resolves a human-meaningful account reference (a chart-of-accounts code, optionally scoped to
 * a merchant) into the `ledger_accounts` UUID that `LedgerEntry` rows point at. Callers of
 * `LedgerService.post()` should never need to know account UUIDs.
 *
 * Platform accounts are seeded once (Phase 0 migration) and always exist. Per-merchant accounts
 * are created the first time that merchant is paid, so onboarding a merchant never has to
 * pre-provision ledger rows for every code it might eventually need.
 */
@Injectable()
export class AccountRegistryService {
  constructor(
    @InjectRepository(LedgerAccount)
    private readonly accounts: Repository<LedgerAccount>,
  ) {}

  async resolvePlatformAccount(code: string, assetCode: AssetCode): Promise<string> {
    const account = await this.accounts.findOne({
      where: { code, assetCode, ownerType: "platform" },
    });
    if (!account) {
      throw new Error(`No platform ledger account for code ${code} / asset ${assetCode}`);
    }
    return account.id;
  }

  async resolveMerchantAccount(
    code: string,
    assetCode: AssetCode,
    merchantId: string,
  ): Promise<string> {
    const existing = await this.accounts.findOne({
      where: { code, assetCode, ownerType: "merchant", ownerId: merchantId },
    });
    if (existing) {
      return existing.id;
    }

    return this.createMerchantAccount(code, assetCode, merchantId);
  }

  private async createMerchantAccount(
    code: string,
    assetCode: AssetCode,
    merchantId: string,
  ): Promise<string> {
    const definition = MERCHANT_ACCOUNT_DEFINITIONS[code];
    if (!definition) {
      throw new Error(`No merchant account definition for code ${code}`);
    }

    const created = this.accounts.create({
      code,
      name: definition.name,
      accountType: definition.accountType,
      normalSide: definition.normalSide,
      assetCode,
      ownerType: "merchant",
      ownerId: merchantId,
      allowsNegative: false,
      isActive: true,
    });
    const saved = await this.accounts.save(created);
    return saved.id;
  }
}
