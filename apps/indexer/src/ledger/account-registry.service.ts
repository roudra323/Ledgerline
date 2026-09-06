import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import type { AssetCode } from "@ledgerline/shared";

import { LedgerAccount, type AccountType, type NormalSide } from "./entities/ledger-account.entity";

interface MerchantAccountDefinition {
  readonly name: string;
  readonly accountType: AccountType;
  readonly normalSide: NormalSide;
  /** The one asset this code exists in. An account code is not asset-agnostic. */
  readonly assetCode: AssetCode;
}

/**
 * Per-merchant account codes and the row shape AccountRegistryService creates on demand.
 * Describes the per-merchant rows of the chart of accounts in docs/architecture.md §3.3 — that
 * table and the seeding migration own the codes; this is the subset created lazily rather than
 * seeded, because it is per-counterparty.
 */
const MERCHANT_ACCOUNT_DEFINITIONS: Readonly<Record<string, MerchantAccountDefinition>> = {
  "1300": {
    name: "merchant_receivable",
    accountType: "asset",
    normalSide: "debit",
    assetCode: "USD",
  },
  "2000": {
    name: "merchant_payable",
    accountType: "liability",
    normalSide: "credit",
    assetCode: "USDX",
  },
  "2010": {
    name: "merchant_fiat_payable",
    accountType: "liability",
    normalSide: "credit",
    assetCode: "USD",
  },
  "2200": {
    name: "frozen_payable",
    accountType: "liability",
    normalSide: "credit",
    assetCode: "USDX",
  },
};

/**
 * Resolves a human-meaningful account reference (a chart-of-accounts code, optionally scoped to
 * a merchant) into the `ledger_accounts` UUID that `LedgerEntry` rows point at. Callers of
 * `LedgerService.post()` should never need to know account UUIDs.
 *
 * Platform accounts are seeded once (1754006400000) and always exist. Per-merchant accounts are
 * created the first time that merchant is paid, so onboarding a merchant never has to
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

  /**
   * Creates the merchant's account for `code`, tolerating a concurrent caller creating it first.
   *
   * The `findOne` above is a fast path, not a guard — two first-time payments for one merchant can
   * both miss it. `ON CONFLICT DO NOTHING` against `ledger_accounts_identity_uk` makes the loser a
   * no-op that re-selects the winner's row, rather than a unique violation that fails a legitimate
   * payment.
   */
  private async createMerchantAccount(
    code: string,
    assetCode: AssetCode,
    merchantId: string,
  ): Promise<string> {
    const definition = MERCHANT_ACCOUNT_DEFINITIONS[code];
    if (!definition) {
      throw new Error(`No merchant account definition for code ${code}`);
    }
    if (definition.assetCode !== assetCode) {
      throw new Error(
        `Merchant account ${code} (${definition.name}) is denominated in ${definition.assetCode}, not ${assetCode}`,
      );
    }

    const inserted = await this.accounts.query<{ id: string }[]>(
      `INSERT INTO ledger_accounts
         (code, name, account_type, normal_side, asset_code, owner_type, owner_id, allows_negative, is_active)
       VALUES ($1, $2, $3, $4, $5, 'merchant', $6, false, true)
       ON CONFLICT (code, asset_code, owner_type, owner_id) DO NOTHING
       RETURNING id`,
      [code, definition.name, definition.accountType, definition.normalSide, assetCode, merchantId],
    );

    const insertedRow = inserted[0];
    if (insertedRow) {
      return insertedRow.id;
    }

    const winner = await this.accounts.findOne({
      where: { code, assetCode, ownerType: "merchant", ownerId: merchantId },
    });
    if (!winner) {
      throw new Error(
        `ledger_accounts insert for ${code}/${assetCode}/merchant ${merchantId} conflicted but no existing row was found`,
      );
    }
    return winner.id;
  }
}
