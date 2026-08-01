/**
 * MetricsService — owns every ledgerline_* Prometheus instrument.
 *
 * Naming: `ledgerline_` prefix, standard units, LOW-cardinality labels only
 * (sync_key, event_name, provider, contract, route) — NEVER user addresses or tx hashes.
 *
 * TODO(Phase 3) register the full instrument set (see docs/observability.md):
 *   Indexer health:
 *     ledgerline_indexer_lag_blocks{sync_key}                gauge
 *     ledgerline_indexer_lag_seconds{sync_key}               gauge
 *     ledgerline_chunk_size{sync_key}                        gauge
 *     ledgerline_chunks_processed_total{sync_key,result}     counter
 *     ledgerline_chunk_duration_seconds{sync_key,phase}      histogram
 *     ledgerline_events_ingested_total{contract,event_name}  counter
 *     ledgerline_events_failed_total{event_name}             counter
 *     ledgerline_events_retried_total{event_name,result}     counter
 *     ledgerline_reorg_rollbacks_total{sync_key}             counter
 *     ledgerline_reorg_depth_blocks                          histogram
 *     ledgerline_reconciliation_drift_wei                    gauge
 *     ledgerline_catchup_remaining_blocks{sync_key}          gauge
 *   RPC layer:
 *     ledgerline_rpc_requests_total{provider,method,result}      counter
 *     ledgerline_rpc_request_duration_seconds{provider,method}   histogram
 *     ledgerline_rpc_provider_healthy{provider}                  gauge (0/1)
 *   API (RED) + default prom-client runtime metrics + pg pool gauges.
 */

export {};
