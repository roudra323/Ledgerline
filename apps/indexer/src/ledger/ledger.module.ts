/**
 * LedgerModule — the double-entry ledger (docs/decisions/0004-double-entry-ledger.md).
 *
 * The only module permitted to write `ledger_transactions` / `ledger_entries`. Everything else
 * asks it to post; nothing else touches those tables.
 *
 * TODO(Phase 1):
 *   - entities: LedgerAccount, LedgerTransaction, LedgerEntry, LedgerAccountBalance.
 *   - LedgerService.post() — the single writer. Validates in app code for a good error message,
 *     then lets the deferred constraint trigger be the backstop.
 *   - TrialBalanceAuditor (invariant I2) on a 5-minute cron.
 */

export {};
