/**
 * ApiModule — the read API. Queries PROJECTIONS ONLY, never the chain and never an external rail.
 *
 * TODO(Part 6):
 *   - POST /payment-intents            (Idempotency-Key required)
 *   - GET  /payment-intents/:id
 *   - GET  /merchants/:id/balance      from ledger_account_balances
 *   - GET  /merchants/:id/payments
 *   - GET  /health                     lag, cursors, outbox depth — reports staleness honestly
 * TODO(Part 8): POST /payment-intents/:id/refunds
 * TODO(Part 9): POST /payouts
 *
 * Thin controllers, fat services. Every inbound DTO is validated.
 */

export {};
