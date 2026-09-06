/**
 * SagasModule — the three orchestrators: on-ramp, refund, payout.
 *
 * State machines are specified in docs/build-plan.md Part 2. Transitions are applied by inserting
 * `saga_transitions` rows; UNIQUE(saga_type, saga_id, cause_type, cause_id) makes replays no-ops.
 *
 * TODO(Part 6): OnrampSaga + payment_intents, idempotency keys, quote expiry.
 * TODO(Part 8): RefundSaga — chain first, then fiat (docs/decisions/0008-compensation-ordering.md).
 * TODO(Part 9): PayoutSaga — burn first, then fiat. Float reservation before submission.
 *
 * TODO(Part 6): TransitionClassifier — the IGNORE / DEFER / ILLEGAL tri-state. A transition whose
 *   from_status doesn't match is never silently dropped and never a bare exception.
 */

export {};
