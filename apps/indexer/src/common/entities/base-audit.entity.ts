import { CreateDateColumn } from "typeorm";

/**
 * Base class for append-only tables: assets, ledger_accounts, ledger_transactions, ledger_entries.
 *
 * None of them is updated after insert — corrections go through reversing entries — but they are
 * not all protected the same way, and the difference matters when reasoning about what a second
 * writer could do:
 *
 *   - `ledger_transactions` / `ledger_entries` — a BEFORE UPDATE OR DELETE trigger that raises
 *     (1754006400003). It fires for the table owner too, so this is a real guarantee.
 *   - `assets` / `ledger_accounts` — convention plus an absent grant. `ledgerline_app` is never
 *     granted UPDATE or DELETE, but the owning role could still change a row.
 *
 * `updated_at` and `deleted_at` are intentionally absent, to reflect that contract in the type.
 */
export abstract class BaseAuditEntity {
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
