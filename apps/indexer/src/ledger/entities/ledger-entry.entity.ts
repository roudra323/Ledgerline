import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import type { AmountMinor } from "@ledgerline/shared";

import { BaseAuditEntity } from "../../common/entities/base-audit.entity";

import { Asset } from "./asset.entity";
import { LedgerAccount } from "./ledger-account.entity";
import { LedgerTransaction } from "./ledger-transaction.entity";

export type EntryDirection = "debit" | "credit";

/**
 * LedgerEntry Entity — maps the `ledger_entries` database table.
 *
 * Immutable line items of a double-entry transaction. Every transaction contains 2+ entries
 * where Σ debits = Σ credits per asset. UPDATE/DELETE queries are revoked on this table.
 */
@Entity("ledger_entries")
@Index("ledger_entries_tx_seq_uk", ["transactionId", "sequence"], { unique: true })
export class LedgerEntry extends BaseAuditEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "transaction_id", type: "uuid" })
  transactionId!: string;

  @ManyToOne(() => LedgerTransaction, (tx) => tx.entries, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "transaction_id" })
  transaction!: LedgerTransaction;

  @Column({ name: "account_id", type: "uuid" })
  accountId!: string;

  @ManyToOne(() => LedgerAccount, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "account_id" })
  account!: LedgerAccount;

  @Column({ name: "direction", type: "text" })
  direction!: EntryDirection;

  @Column({ name: "asset_code", type: "text" })
  assetCode!: string;

  @ManyToOne(() => Asset, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "asset_code", referencedColumnName: "assetCode" })
  asset!: Asset;

  /**
   * Amount in minor units stored as a numeric string (numeric(38,0) in Postgres).
   * NEVER JS number.
   */
  @Column({ name: "amount_minor", type: "numeric", precision: 38, scale: 0 })
  amountMinor!: AmountMinor;

  /**
   * Position of this line within the transaction (0-based). Together with `transaction_id`
   * this forms the unique constraint `ledger_entries_tx_seq_uk`, which makes the entry set
   * deterministic and reproducible — replaying the same event always produces identical lines
   * in the same order.
   */
  @Column({ name: "sequence", type: "smallint" })
  sequence!: number;

  /**
   * When set, this entry is a correction that nullifies an earlier entry.
   * Corrections are ALWAYS new reversing entries — never edits to the original row.
   * This preserves the full audit trail: both the original entry and its reversal remain
   * permanently readable in `ledger_entries`.
   */
  @Column({ name: "reverses_id", type: "uuid", nullable: true })
  reversesId!: string | null;

  @ManyToOne(() => LedgerEntry, { nullable: true, onDelete: "RESTRICT" })
  @JoinColumn({ name: "reverses_id" })
  reversesEntry!: LedgerEntry | null;
}
