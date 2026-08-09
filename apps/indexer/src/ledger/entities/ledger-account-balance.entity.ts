import { Column, Entity, JoinColumn, ManyToOne, OneToOne, PrimaryColumn } from "typeorm";

import type { AmountMinor } from "@ledgerline/shared";

import { MutableAuditEntity } from "../../common/entities/mutable-audit.entity";

import { Asset } from "./asset.entity";
import { LedgerAccount } from "./ledger-account.entity";
import { LedgerEntry } from "./ledger-entry.entity";

/**
 * LedgerAccountBalance Entity — maps the `ledger_account_balances` database table.
 *
 * A calculated projection of the net balance for each ledger account. Disposable by design —
 * drop the row and re-derive at any time by summing `ledger_entries` for that account.
 *
 * `lastEntryId` is a resume watermark: the balance updater records which `ledger_entry` was
 * the last one folded in, so incremental recalculations can start from exactly that point
 * rather than re-scanning the full entry history on every posting.
 */
@Entity("ledger_account_balances")
export class LedgerAccountBalance extends MutableAuditEntity {
  @PrimaryColumn({ name: "account_id", type: "uuid" })
  accountId!: string;

  @OneToOne(() => LedgerAccount, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "account_id" })
  account!: LedgerAccount;

  @Column({ name: "asset_code", type: "text" })
  assetCode!: string;

  @ManyToOne(() => Asset, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "asset_code", referencedColumnName: "assetCode" })
  asset!: Asset;

  @Column({ name: "balance_minor", type: "numeric", precision: 38, scale: 0, default: "0" })
  balanceMinor!: AmountMinor;

  @Column({ name: "last_entry_id", type: "uuid", nullable: true })
  lastEntryId!: string | null;

  @ManyToOne(() => LedgerEntry, { nullable: true, onDelete: "RESTRICT" })
  @JoinColumn({ name: "last_entry_id" })
  lastEntry!: LedgerEntry | null;
}
