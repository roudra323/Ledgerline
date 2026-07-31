# ChainStake — Observability

Three signals, one correlation loop: **metrics** (Prometheus/Grafana) → **traces** (OTel → Jaeger)
→ **logs** (pino with `trace_id`). A latency spike in Grafana links to a Jaeger trace, whose
`trace_id` greps the structured logs.

## 1. Metrics

Conventions: `chainstake_` prefix, standard units, **low-cardinality labels only**
(`sync_key`, `event_name`, `provider`, `contract`, `route`). Never user addresses or tx hashes as
labels — those belong in span attributes and logs.

### Indexer health

| Metric                                | Type      | Labels                                                 |
| ------------------------------------- | --------- | ------------------------------------------------------ |
| `chainstake_indexer_lag_blocks`       | gauge     | `sync_key`                                             |
| `chainstake_indexer_lag_seconds`      | gauge     | `sync_key`                                             |
| `chainstake_chunk_size`               | gauge     | `sync_key`                                             |
| `chainstake_chunks_processed_total`   | counter   | `sync_key`, `result` (ok\|rpc_error\|db_error)         |
| `chainstake_chunk_duration_seconds`   | histogram | `sync_key`, `phase` (fetch\|decode\|persist\|dispatch) |
| `chainstake_events_ingested_total`    | counter   | `contract`, `event_name`                               |
| `chainstake_events_failed_total`      | counter   | `event_name`                                           |
| `chainstake_events_retried_total`     | counter   | `event_name`, `result`                                 |
| `chainstake_reorg_rollbacks_total`    | counter   | `sync_key`                                             |
| `chainstake_reorg_depth_blocks`       | histogram | —                                                      |
| `chainstake_reconciliation_drift_wei` | gauge     | —                                                      |
| `chainstake_catchup_remaining_blocks` | gauge     | `sync_key`                                             |

### RPC layer

| Metric                                    | Type        | Labels                         |
| ----------------------------------------- | ----------- | ------------------------------ |
| `chainstake_rpc_requests_total`           | counter     | `provider`, `method`, `result` |
| `chainstake_rpc_request_duration_seconds` | histogram   | `provider`, `method`           |
| `chainstake_rpc_provider_healthy`         | gauge (0/1) | `provider`                     |

### API (RED method, via a global interceptor)

| Metric                          | Type      | Labels                      |
| ------------------------------- | --------- | --------------------------- |
| `http_requests_total`           | counter   | `route`, `method`, `status` |
| `http_request_duration_seconds` | histogram | `route`                     |
| `http_requests_in_flight`       | gauge     | —                           |

### Runtime

Default `prom-client` metrics (event loop lag, heap, GC) + `pg` pool gauges. Postgres itself via the
`postgres-exporter` container.

## 2. Dashboards (provisioned, in git)

- **Indexer Operations** (`infra/grafana/dashboards/indexer-operations.json`): lag (blocks/seconds)
  per `sync_key`, chain head vs cursor, events/min by `event_name`, chunk-duration heatmap by phase,
  adaptive chunk size, failed/retried events, reorg counter, reconciliation-drift stat, RPC p95 +
  error rate.
- **API & Runtime (APM)** (`infra/grafana/dashboards/api-runtime.json`): RED per route
  (p50/p95/p99), Apdex, event loop lag, heap, GC, DB pool saturation, panel links → Jaeger.

## 3. Alerts

Defined in `infra/prometheus/alerts.yml`, routed via Alertmanager:

| Alert                   | Condition                                    | Severity        |
| ----------------------- | -------------------------------------------- | --------------- |
| `IndexerLagHigh`        | `lag_seconds > 120` for 5m                   | warning         |
| `IndexerStalled`        | `increase(chunks_processed_total[10m]) == 0` | critical        |
| `EventProcessingFailed` | `increase(events_failed_total[5m]) > 0`      | critical        |
| `ReconciliationDrift`   | `drift_wei != 0` for 10m                     | critical (page) |
| `RpcProviderDown`       | `provider_healthy == 0` for 3m               | warning         |
| `ApiP95High`            | route p95 > 500ms for 10m                    | warning         |

## 4. Tracing

`otel.ts` bootstraps the NodeSDK **before Nest** (auto-instrumentations: http, express/nest, pg,
undici). Exporter: OTLP → **OTel Collector** → Jaeger (collector in the middle for batching/retry
and vendor portability).

Custom spans that tell the story:

```
indexer.chunk (root)                 attrs: sync_key, from_block, to_block, log_count
 ├── rpc.get_logs                    attrs: provider, chunk_size, retry_count
 ├── reorg.continuity_check
 ├── db.persist_raw_events           attrs: inserted, deduped
 └── dispatch
      ├── handler.Staked             attrs: tx_hash, log_index, block_number
      └── handler.Withdrawn ...
replay.rebuild (root)                attrs: projections, event_count
api.* (auto) → spans through pg queries
```

Handlers `span.recordException` and set error status → failed events are red spans, searchable in
Jaeger by `tx_hash`.

## 5. Logs

nestjs-pino, JSON output, level from `LOG_LEVEL`. A pino mixin injects `trace_id`/`span_id` from the
active OTel span into every line, closing the logs ↔ traces loop. (Stretch: Loki + promtail linked
in Grafana.)
