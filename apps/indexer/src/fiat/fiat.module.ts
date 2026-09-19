/**
 * FiatModule — the off-chain source of truth (docs/decisions/0002-fiat-events-log.md).
 *
 * Mirrors the on-chain ingest path: append-only log, provider-supplied dedupe key, dispatch in a
 * separate worker.
 *
 * TODO(Part 5):
 *   - WebhookController: verify HMAC over the RAW body (timingSafeEqual, ±5min window) →
 *     INSERT ... ON CONFLICT DO NOTHING → 200. NO business logic in the request.
 *   - FiatEvent entity, UNIQUE(provider, provider_event_id).
 *   - FiatDispatcher: reads pending/deferred/unmatched rows, advances sagas via the classifier.
 *   - PaymentGatewayPort + MockPspAdapter.
 *   - PspReconciler (hourly poll, invariant I6) — synthesizes a fiat_events row for a webhook we
 *     never received, with an id that still dedupes against the real one if it arrives later.
 * TODO(Part 12): StripeAdapter behind the same port; contract-tested against stripe-mock.
 */

export {};
