# Ledgerline — Observability

Three signals, one correlation loop: **metrics** (Prometheus/Grafana) → **traces** (OTel → Jaeger) →
**logs** (pino with `trace_id`). A drift gauge in Grafana links to a Jaeger trace, whose `trace_id`
greps the structured logs.

The payment-specific goal on top of that: **one trace spans both source-of-truth logs.** The trace id
is written into the PSP metadata at capture and correlated through the `bytes32 paymentId` on-chain,
so a Jaeger search by payment intent shows _fiat → chain → settlement_ as a single story. That one
screenshot is the demo.

---

## 1. Metrics

**Prefix:** `ledgerline_`. **Units** in the name (`_seconds`, `_minor`, `_wei`, `_total`, `_ratio`).

**Permitted labels — this list is exhaustive:**

```
saga_type · status · to_status · terminal_status · provider · event_type · asset
contract · event_name · sync_key · kind · role · route · method · result
gate · decision · reason_class · check · operation · account_code · direction
```

**Never as a label:** merchant id, customer id, wallet address, tx hash, payment id, idempotency key.
Those belong in **span attributes and structured logs**, where cardinality is free.

> **The cardinality constraint that shapes a real metric.** Invariant I5 is per-merchant drift, and
> merchant id cannot be a label. So it is exported as an _aggregate_ —
> `ledgerline_merchants_with_drift` (count) plus the maximum absolute drift — and the merchant id is
> resolved by a query **at alert time** into the alert annotation. This is what the label rule looks
> like when it actually bites, and working with it rather than around it is the point.

### 1.1 Fiat rail

| Metric                                        | Type      | Labels                                                                        |
| --------------------------------------------- | --------- | ----------------------------------------------------------------------------- |
| `ledgerline_fiat_events_received_total`       | counter   | `provider`, `event_type`                                                      |
| `ledgerline_fiat_events_processed_total`      | counter   | `provider`, `event_type`, `result` (ok\|deferred\|unmatched\|failed\|ignored) |
| `ledgerline_fiat_event_lag_seconds`           | histogram | `provider` (received_at → processed_at)                                       |
| `ledgerline_unmatched_fiat_events`            | gauge     | `provider`                                                                    |
| `ledgerline_webhook_signature_failures_total` | counter   | `provider`                                                                    |
| `ledgerline_psp_clock_skew_seconds`           | gauge     | `provider`                                                                    |
| `ledgerline_psp_request_duration_seconds`     | histogram | `provider`, `operation`, `result`                                             |
| `ledgerline_psp_poll_recovered_total`         | counter   | `provider`                                                                    |

### 1.2 Sagas

| Metric                                       | Type      | Labels                         |
| -------------------------------------------- | --------- | ------------------------------ |
| `ledgerline_saga_transitions_total`          | counter   | `saga_type`, `to_status`       |
| `ledgerline_sagas_in_state`                  | gauge     | `saga_type`, `status`          |
| `ledgerline_saga_duration_seconds`           | histogram | `saga_type`, `terminal_status` |
| `ledgerline_saga_compensations_total`        | counter   | `saga_type`, `reason_class`    |
| `ledgerline_sagas_manual_review`             | gauge     | `saga_type`                    |
| `ledgerline_saga_illegal_transitions_total`  | counter   | `saga_type`                    |
| `ledgerline_saga_deferred_transitions_total` | counter   | `saga_type`                    |

### 1.3 Ledger

| Metric                                      | Type    | Labels                                                                                                       |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `ledgerline_trial_balance_residual_minor`   | gauge   | `asset` — **must be 0**                                                                                      |
| `ledgerline_balance_projection_drift_minor` | gauge   | `asset`                                                                                                      |
| `ledgerline_ledger_entries_written_total`   | counter | `kind`                                                                                                       |
| `ledgerline_account_balance_minor`          | gauge   | `account_code`, `asset` — **platform accounts only** (a bounded set; per-merchant accounts are not exported) |
| `ledgerline_rounding_residual_minor`        | gauge   | `asset`                                                                                                      |
| `ledgerline_merchant_debt_minor`            | gauge   | `asset` (aggregate across merchants)                                                                         |

### 1.4 Reconciliation — the money-truth panel

| Metric                                           | Type      | Labels                  |
| ------------------------------------------------ | --------- | ----------------------- |
| `ledgerline_reserve_coverage_ratio`              | gauge     | — **the headline**      |
| `ledgerline_supply_drift_minor`                  | gauge     | `asset`                 |
| `ledgerline_treasury_drift_minor`                | gauge     | `asset`                 |
| `ledgerline_psp_drift_minor`                     | gauge     | `provider`, `direction` |
| `ledgerline_merchants_with_drift`                | gauge     | —                       |
| `ledgerline_unknown_outflows_total`              | counter   | `asset`                 |
| `ledgerline_reconciliation_run_duration_seconds` | histogram | `check`                 |

### 1.5 Chain write path

| Metric                                        | Type      | Labels                 |
| --------------------------------------------- | --------- | ---------------------- |
| `ledgerline_chain_tx_submitted_total`         | counter   | `kind`                 |
| `ledgerline_chain_tx_confirmed_total`         | counter   | `kind`                 |
| `ledgerline_chain_tx_reverted_total`          | counter   | `kind`, `reason_class` |
| `ledgerline_chain_tx_rebroadcasts_total`      | counter   | `kind`                 |
| `ledgerline_chain_tx_inflight`                | gauge     | `role`                 |
| `ledgerline_chain_tx_confirmation_seconds`    | histogram | `kind`                 |
| `ledgerline_chain_nonce_gap_depth`            | gauge     | `role`                 |
| `ledgerline_chain_tx_stuck`                   | gauge     | `role`                 |
| `ledgerline_chain_account_balance_wei`        | gauge     | `role`                 |
| `ledgerline_gas_spent_wei_total`              | counter   | `kind`                 |
| `ledgerline_receipt_disagreement_total`       | counter   | `provider`             |
| `ledgerline_minter_allowance_remaining_minor` | gauge     | —                      |

### 1.6 Outbox and compliance

| Metric                                     | Type      | Labels                         |
| ------------------------------------------ | --------- | ------------------------------ |
| `ledgerline_outbox_depth`                  | gauge     | `kind`, `status`               |
| `ledgerline_outbox_processed_total`        | counter   | `kind`, `result`               |
| `ledgerline_outbox_oldest_pending_seconds` | gauge     | `kind`                         |
| `ledgerline_screening_checks_total`        | counter   | `provider`, `gate`, `decision` |
| `ledgerline_screening_duration_seconds`    | histogram | `provider`                     |
| `ledgerline_screening_unavailable_total`   | counter   | `provider`                     |
| `ledgerline_signing_requests_total`        | counter   | `role`, `decision`             |

### 1.7 Inherited (unchanged)

Indexer health (`ledgerline_indexer_lag_blocks|_seconds`, `chunk_size`, `chunks_processed_total`,
`chunk_duration_seconds`, `events_ingested_total`, `events_failed_total`, `reorg_rollbacks_total`,
`reorg_depth_blocks`, `catchup_remaining_blocks`), the RPC layer
(`rpc_requests_total`, `rpc_request_duration_seconds`, `rpc_provider_healthy`), API RED
(`http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`), and default
`prom-client` runtime metrics plus `postgres-exporter`.

---

## 2. Dashboards (provisioned, in git)

1. **Money Truth** — `reserve_coverage_ratio` as a large single-stat, trial-balance residual, the four
   drift gauges, platform account balances, merchant debt. _This is the README screenshot._
2. **Saga Flow** — `sagas_in_state` as a funnel per saga type, transition rate by `to_status`,
   duration heatmap, compensation rate, manual-review count.
3. **Chain Writer** — inflight / confirmed / reverted by `reason_class`, confirmation-time histogram,
   rebroadcasts, nonce-gap depth, gas balance and spend, minter allowance remaining.
4. **Rails & Queues** — PSP latency and errors, webhook lag, unmatched events, outbox depth and
   oldest-pending, screening decisions by gate.
5. **Indexer Operations** _(inherited)_ — lag, chain head vs cursor, chunk duration by phase, adaptive
   chunk size, reorg counter.
6. **API & Runtime** _(inherited)_ — RED per route, event loop lag, heap, GC, DB pool saturation,
   panel links into Jaeger.

---

## 3. Alerts

Defined in `infra/prometheus/alerts.yml`, routed via Alertmanager. Every alert has a runbook entry.

### Pages

| Alert                      | Condition                                  |
| -------------------------- | ------------------------------------------ |
| `TrialBalanceBroken`       | `trial_balance_residual_minor != 0` for 1m |
| `ReserveCoverageLow`       | `reserve_coverage_ratio < 1` for 5m        |
| `UnknownTreasuryOutflow`   | `increase(unknown_outflows_total[5m]) > 0` |
| `ReorgBeyondConfirmations` | any occurrence                             |

### Critical

| Alert                           | Condition                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `SupplyDrift` / `TreasuryDrift` | `!= 0` for 10m                                                                     |
| `PspDrift`                      | `abs(psp_drift_minor) > 0` for 30m                                                 |
| `ForgedFiatEvent`               | `increase(webhook_signature_failures_total[10m]) > 3`                              |
| `RpcDisagreement`               | `increase(receipt_disagreement_total[10m]) > 0`                                    |
| `SagaStuck`                     | `sagas_in_state{status=~"chain_submitted\|fiat_submitted"}` non-decreasing for 15m |
| `StuckTransaction`              | `chain_tx_stuck > 0` for 5m                                                        |
| `NonceGap`                      | `chain_nonce_gap_depth > 0` for 5m                                                 |
| `OutboxDeadLetter`              | `increase(outbox_processed_total{result="dead"}[15m]) > 0`                         |
| `IllegalSagaTransition`         | any occurrence                                                                     |
| `IndexerStalled`                | `increase(chunks_processed_total[10m]) == 0`                                       |

### Warning

`SagasInManualReview` · `GasBalanceLow` · `FloatBelowMinimum` · `MinterAllowanceLow` ·
`OutboxBacklog` · `UnmatchedFiatEventAging` · `ScreeningUnavailable` · `IndexerLagHigh` ·
`RpcProviderDown` · `ApiP95High`

---

## 4. Tracing

`otel.ts` bootstraps the NodeSDK **before Nest** (auto-instrumentations: http, express/nest, pg,
undici). Exporter: OTLP → **OTel Collector** → Jaeger. The collector sits in the middle for batching,
retry and vendor portability — not decoration.

Resource attributes: `service.name`, `service.version` from the git SHA, `deployment.environment`.

```
http.POST /payment-intents             attrs: merchant_id, idempotency_key
 └── onramp.create
      ├── pricing.quote                attrs: fx_rate, fee_bps, token_amount
      ├── compliance.screen            attrs: gate=pre_credit
      │    ├── screening.ofac_sdn      attrs: list_version, decision
      │    └── screening.chain_risk    attrs: score, decision
      ├── ledger.post                  attrs: ledger_tx_id, kind, entry_count
      └── outbox.enqueue               attrs: kind, dedupe_key

fiat.dispatch (root)                   attrs: provider, event_type, provider_event_id
 ├── saga.transition                   attrs: saga_type, from, to, classification
 └── ledger.post

chain.submit (root)                    attrs: intent_key, kind, nonce
 ├── chain.simulate                    attrs: gas_estimate, revert_reason?
 ├── policy.check                      attrs: role, decision
 ├── signer.sign                       attrs: signer_ref   (NEVER key material)
 ├── db.persist_attempt                attrs: tx_hash, attempt_number
 └── rpc.send_raw_transaction          attrs: provider, result

chain.watch (root) → rpc.get_receipt → chain.confirm
indexer.chunk (inherited) → dispatch → handler.PaymentSettled → saga.transition → ledger.post
reconcile.run (root) → check.supply | check.treasury | check.psp | check.trial_balance
replay.rebuild (root)                  attrs: projections, entry_count
```

Handlers call `span.recordException` and set an error status, so failed events are red spans
searchable by `tx_hash` or `payment_intent_id` attribute.

---

## 5. Logs

nestjs-pino, JSON output, level from `LOG_LEVEL`. A pino mixin injects `trace_id` / `span_id` from the
active OTel span into every line, closing the logs ↔ traces loop.

**Never logged:** private keys, signer material, PSP secrets, webhook signing secrets, raw card data,
full webhook payloads containing PII. High-cardinality _identifiers_ (addresses, tx hashes, payment
ids) are the opposite — they belong here, because this is the layer where cardinality is free and
where you actually need them at 3am.

_(Stretch: Loki + promtail, linked from Grafana.)_
