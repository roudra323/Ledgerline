/**
 * MetricsService — owns every chainstake_* Prometheus instrument.
 *
 * Naming: `chainstake_` prefix, standard units, LOW-cardinality labels only
 * (sync_key, event_name, provider, contract, route) — NEVER user addresses or tx hashes.
 *
 * TODO(Phase 3) register the full instrument set (see docs/observability.md):
 *   Indexer health:
 *     chainstake_indexer_lag_blocks{sync_key}                gauge
 *     chainstake_indexer_lag_seconds{sync_key}               gauge
 *     chainstake_chunk_size{sync_key}                        gauge
 *     chainstake_chunks_processed_total{sync_key,result}     counter
 *     chainstake_chunk_duration_seconds{sync_key,phase}      histogram
 *     chainstake_events_ingested_total{contract,event_name}  counter
 *     chainstake_events_failed_total{event_name}             counter
 *     chainstake_events_retried_total{event_name,result}     counter
 *     chainstake_reorg_rollbacks_total{sync_key}             counter
 *     chainstake_reorg_depth_blocks                          histogram
 *     chainstake_reconciliation_drift_wei                    gauge
 *     chainstake_catchup_remaining_blocks{sync_key}          gauge
 *   RPC layer:
 *     chainstake_rpc_requests_total{provider,method,result}      counter
 *     chainstake_rpc_request_duration_seconds{provider,method}   histogram
 *     chainstake_rpc_provider_healthy{provider}                  gauge (0/1)
 *   API (RED) + default prom-client runtime metrics + pg pool gauges.
 */

export {};
