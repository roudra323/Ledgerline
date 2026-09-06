/**
 * Load generator — a first-class deliverable, not an afterthought. Empty dashboards prove nothing.
 *
 * TODO(Part 7):
 *   - drive the real API, not the chain directly: POST /payment-intents with unique
 *     Idempotency-Keys, at a configurable rate across N merchants and customers.
 *   - a weighted action mix: mostly on-ramp, some refunds (incl. partials), some payouts.
 *   - deliberately replay a small fraction of requests with the SAME idempotency key, so the
 *     dedupe path is exercised continuously rather than only in tests.
 *   - periodically hit the mock-psp fault API so the failure paths appear in the demo:
 *     duplicate, reorder, delay, drop-webhook, wrong-amount.
 *   - keep amounts bounded so refunds never exceed captures and payouts never exceed balances —
 *     the point is to exercise the happy path plus DESIGNED faults, not to trip guards at random.
 */

console.log("[loadgen] stub — implemented in Phase 7.");
