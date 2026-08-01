/**
 * mock-psp — a deterministic fake payment provider.
 *
 * This service exists for ONE reason: to make the fiat rail's failure modes reproducible. A real
 * PSP in test mode cannot be told "duplicate this webhook, then deliver the next one out of order,
 * then drop the third." Without that, every entry in the A-group of docs/failure-modes.md is a
 * claim rather than a tested behaviour.
 *
 * TODO(Phase 5) — payment API (mirrors the shape of a real PSP):
 *   POST /v1/payment_intents          honours an Idempotency-Key header
 *   POST /v1/payment_intents/:id/capture
 *   POST /v1/refunds
 *   POST /v1/payouts
 *   GET  /v1/:object/:id              for the reconciliation poller (failure mode A5)
 *   GET  /v1/settlement_report        daily CSV, for the three-way match
 *
 * TODO(Phase 5) — webhooks:
 *   HMAC-SHA256 over the RAW body, with a timestamp in the signature header, exactly as Stripe
 *   does. Delivery retries with backoff. Deterministic, monotonic event ids so tests can assert on
 *   them.
 *
 * TODO(Phase 5) — the fault-injection API. This is the interesting part:
 *   POST /_fault { kind, count?, delayMs?, amountDeltaMinor?, skewSeconds? }
 *     duplicate      deliver the next N webhooks twice           -> A1
 *     reorder        hold a webhook and deliver it after the next -> A3
 *     delay          delay delivery by delayMs                    -> A2
 *     drop_webhook   never deliver; the poller must recover it    -> A5
 *     fail_capture   return a decline                             -> capture_failed
 *     wrong_amount   capture a different amount than quoted       -> A9
 *     late_return    deliver payout.returned days later           -> A16
 *     clock_skew     stamp events with a skewed timestamp         -> A8
 *     bad_signature  sign with the wrong secret                   -> A6
 *   DELETE /_fault  clear all armed faults
 *   GET    /_state  inspect objects and armed faults (tests assert against this)
 *
 * Faults are ARMED, not random: a test arms exactly one, runs one payment, and asserts the
 * designed outcome. Determinism is the whole value — a flaky chaos harness gets disabled.
 */

console.log("[mock-psp] stub — implemented in Phase 5.");
