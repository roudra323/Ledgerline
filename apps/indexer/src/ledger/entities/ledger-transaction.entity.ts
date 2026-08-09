import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from "typeorm";

import { BaseAuditEntity } from "../../common/entities/base-audit.entity";

import { LedgerEntry } from "./ledger-entry.entity";

/**
 * All valid business event kinds posted to the double-entry ledger.
 * Must stay in sync with the CHECK constraint in the CreateLedgerTables migration.
 */
export type TransactionKind =
  | "payment_captured"
  | "payment_settled"
  | "payout_requested"
  | "payout_settled"
  | "refund_initiated"
  | "chargeback_received"
  | "on_ramp_completed"
  | "rounding_residual";

/**
 * LedgerTransaction Entity — maps the `ledger_transactions` database table.
 *
 * Represents an immutable business event. The `UNIQUE(kind, cause_type, cause_id)` constraint
 * guarantees database-level idempotency — duplicate webhooks/events fail harmlessly at the DB.
 */
@Entity("ledger_transactions")
@Index("ledger_transactions_cause_uk", ["kind", "causeType", "causeId"], { unique: true })
export class LedgerTransaction extends BaseAuditEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "kind", type: "text" })
  kind!: TransactionKind;

  @Column({ name: "cause_type", type: "text" })
  causeType!: string;

  @Column({ name: "cause_id", type: "text" })
  causeId!: string;

  /**
   * Business timestamp of the event. Set explicitly by LedgerService.post() so replays
   * can back-date postings to their original time. DB default covers the normal path.
   */
  @Column({ name: "posted_at", type: "timestamptz", default: () => "now()" })
  postedAt!: Date;

  @Column({ name: "metadata", type: "jsonb", nullable: true })
  metadata!: Record<string, unknown> | null;

  @OneToMany(() => LedgerEntry, (entry) => entry.transaction)
  entries!: LedgerEntry[];
}
