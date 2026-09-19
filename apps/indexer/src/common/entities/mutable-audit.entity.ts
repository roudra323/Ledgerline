import { CreateDateColumn, UpdateDateColumn } from "typeorm";

/**
 * Base class for mutable projection tables: ledger_account_balances.
 *
 * These tables hold derived state meant to be updated with every posting (from Block 1.7 —
 * until then nothing writes them) — they have a legitimate `updated_at` because they are
 * intentionally mutated. They are also
 * disposable: drop and re-derive from `ledger_entries` at any time.
 *
 * `deleted_at` is still absent — soft-delete is not a concept in this codebase.
 * Deactivation is handled by `is_active` on registry tables; projections are simply
 * overwritten or removed when the account they belong to is deactivated.
 */
export abstract class MutableAuditEntity {
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
