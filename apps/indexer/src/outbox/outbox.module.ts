/**
 * OutboxModule — the transactional outbox (docs/decisions/0005-outbox.md).
 *
 * Solves the dual-write problem: the message row commits in the SAME transaction as the state
 * change that caused it. One table, `kind` discriminator, claimed with FOR UPDATE SKIP LOCKED.
 *
 * Structural requirement (enforced by the OutboxHandler interface, not by convention):
 *   the outbox `dedupe_key` IS the downstream idempotency key — the PSP Idempotency-Key, or
 *   chain_transactions.intent_key. This is what makes at-least-once delivery safe.
 *
 * TODO(Part 5):
 *   - OutboxMessage entity, UNIQUE(kind, dedupe_key).
 *   - OutboxWorker: claim query, retry at now() + min(2^attempt, 3600)s with +/-20% jitter,
 *     lease expiry for crash recovery, `dead` after max_attempts + alert.
 *   - LISTEN/NOTIFY as a latency optimisation ON TOP OF polling — never as the delivery mechanism.
 */

export {};
