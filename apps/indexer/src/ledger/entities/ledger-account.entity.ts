import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { BaseAuditEntity } from "../../common/entities/base-audit.entity";

import { Asset } from "./asset.entity";

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type NormalSide = "debit" | "credit";
export type OwnerType = "platform" | "merchant" | "customer";

/**
 * LedgerAccount Entity — maps the `ledger_accounts` database table.
 *
 * Every unit of money in Ledgerline must reside in a named account.
 *
 * Platform accounts are singletons (`owner_id IS NULL`). Per-counterparty accounts
 * (merchant receivable, customer float) carry an `ownerId` so a single chart of accounts
 * serves all tenants without duplicating code/account definitions.
 *
 * `allowsNegative` is false by default — an overdraft on most accounts is a bug we want
 * surfaced at COMMIT, not silently absorbed. Only the position accounts (fx_clearing,
 * rounding_residual) are allowed to go negative — the FX pair carries a standing position of either
 * sign, not a holding (docs/decisions/0018-ledger-flow-postings.md).
 */
@Entity("ledger_accounts")
export class LedgerAccount extends BaseAuditEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "code", type: "text" })
  code!: string;

  @Column({ name: "name", type: "text" })
  name!: string;

  @Column({ name: "account_type", type: "text" })
  accountType!: AccountType;

  @Column({ name: "normal_side", type: "text" })
  normalSide!: NormalSide;

  @Column({ name: "asset_code", type: "text" })
  assetCode!: string;

  @ManyToOne(() => Asset, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "asset_code", referencedColumnName: "assetCode" })
  asset!: Asset;

  @Column({ name: "owner_type", type: "text" })
  ownerType!: OwnerType;

  @Column({ name: "owner_id", type: "uuid", nullable: true })
  ownerId!: string | null;

  @Column({ name: "allows_negative", type: "boolean", default: false })
  allowsNegative!: boolean;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;
}
