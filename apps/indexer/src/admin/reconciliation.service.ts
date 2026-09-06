/**
 * ReconciliationService — invariants I1-I9 (docs/architecture.md section 4).
 *
 * DESIGN RULE: reconciliation runs with ZERO WRITES in audit mode and produces a report.
 * Auto-healing is a separate, explicitly-invoked action with its own ledger transactions
 * (kind='reconciliation.adjustment'), always with a memo and an operator id. A system that
 * silently self-heals a discrepancy has destroyed the evidence of the bug.
 *
 * TODO(Part 7):
 *   - ChainLedgerReconciler (30s): totalSupply() and balanceOf(treasury) via eth_call
 *     AT head - CONFIRMATIONS, NOT at head. Comparing a settled ledger against unsettled chain
 *     state makes drift oscillate. Compare against ledger balances as of the same block.
 *   - PspReconciler (hourly): forward-only. Never mark something failed because the PSP 404'd —
 *     that is a lookup problem, not a payment outcome.
 *   - SettlementFileReconciler (daily): three-way match of the settlement file against
 *     fiat_events and ledger_entries.
 *   - TrialBalanceAuditor (5m): recompute and compare against the balances projection.
 */

export {};
