/**
 * MerchantsController — merchant-facing reads.
 *
 * TODO(Phase 6):
 *   GET /merchants/:id/balance   from ledger_account_balances (2000 merchant_payable), never
 *                                from an eth_call — the ledger is what we owe, the chain is what
 *                                was delivered, and reconciliation is what proves they agree.
 *   GET /merchants/:id/payments  paginated, from the payment_intents projection.
 *
 * Report staleness honestly: every response carries the block the projection is current as of.
 * Eventual consistency that is surfaced is a design; eventual consistency that is hidden is a bug.
 */

export {};
