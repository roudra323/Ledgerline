import { CreateDateColumn } from "typeorm";

/**
 * Base class for append-only, immutable tables: assets, ledger_accounts,
 * ledger_transactions, and ledger_entries.
 *
 * These tables are NEVER updated after insert and NEVER deleted — corrections
 * go through reversing entries. `updated_at` and `deleted_at` are intentionally
 * absent to prevent misuse and to reflect the true schema contract.
 */
export abstract class BaseAuditEntity {
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
