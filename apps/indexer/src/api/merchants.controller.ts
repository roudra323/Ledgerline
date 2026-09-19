/**
 * MerchantsController — merchant-facing reads.
 *
 * TODO(Part 6):
 *   GET /merchants/:id/balance   from ledger_account_balances, never from an eth_call — the
 *                                ledger is what we owe, the chain is what was delivered, and
 *                                reconciliation is what proves they agree. Report the parts, not
 *                                one number: 2000 merchant_payable is owed-but-not-yet-delivered
 *                                (credited at T3, discharged at T5 — ADR-0018), 2010 is cash owed,
 *                                2200 is frozen, 1300 is what the merchant owes us. Tokens already
 *                                delivered are in the merchant's own wallet, not in the ledger.
 *   GET /merchants/:id/payments  paginated, from the payment_intents projection.
 *
 * Report staleness honestly: every response carries the block the projection is current as of.
 * Eventual consistency that is surfaced is a design; eventual consistency that is hidden is a bug.
 */

export {};
