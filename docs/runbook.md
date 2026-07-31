# ChainStake — Runbook

What to do when an alert fires. Each entry: **meaning → likely causes → resolution → verify.**

---

## IndexerLagHigh (warning)

`chainstake_indexer_lag_seconds{sync_key} > 120` for 5m.

- **Meaning:** the indexer is falling behind the chain head for this sync key.
- **Likely causes:** slow/erroring RPC (chunk size collapsing), DB contention, a backfill/catch-up
  in progress (expected — check `catchup_remaining_blocks`), handler slowness.
- **Resolution:** check `chainstake_chunk_size` (small = RPC pain → confirm failover), RPC latency
  panel, DB pool saturation. If a catch-up is running, confirm `catchup_remaining_blocks` is
  decreasing — then it will self-resolve.
- **Verify:** lag trends back under 120s; chain-head vs cursor lines converge.

## IndexerStalled (critical)

`increase(chainstake_chunks_processed_total[10m]) == 0`.

- **Meaning:** the loop is not advancing at all.
- **Likely causes:** RPC fully down (both providers), DB unavailable, process crashed/wedged, an
  unhandled exception in the tick, stuck mutex.
- **Resolution:** check indexer logs (grep latest `trace_id`), Postgres health, both RPC endpoints.
  Restart the indexer if wedged — crash-safe cursors make this safe.
- **Verify:** `chunks_processed_total` increments again; lag recovers.

## EventProcessingFailed (critical)

`increase(chainstake_events_failed_total{event_name}[5m]) > 0` on funds events.

- **Meaning:** a handler threw for a funds-affecting event; it is dead-lettered.
- **Likely causes:** a handler bug, malformed/unexpected event args, a schema/migration mismatch.
- **Resolution:** inspect `indexer_failures` for the error; find the trace in Jaeger by `tx_hash`
  (red span). Fix the handler, then **replay** the affected projection to reprocess.
- **Verify:** retry succeeds (`events_retried_total{result="ok"}`), failure count stops rising,
  reconciliation drift is 0.

## ReconciliationDrift (critical — page)

`chainstake_reconciliation_drift_wei != 0` for 10m.

- **Meaning:** indexed aggregates disagree with on-chain `totalStaked()`. The DB no longer matches
  the chain — the single most important signal.
- **Likely causes:** a missed/failed event, a handler bug, an unhandled reorg, manual DB tampering.
- **Resolution:** identify the divergence window; check for failed events and recent reorgs. Fix the
  root cause, then **replay from `raw_events`** to rebuild projections deterministically.
- **Verify:** drift returns to 0 and stays there.

## RpcProviderDown (warning)

`chainstake_rpc_provider_healthy{provider} == 0` for 3m.

- **Meaning:** a provider is unreachable/erroring; viem failover should be covering.
- **Likely causes:** provider outage, network, rate limiting.
- **Resolution:** confirm the other provider is healthy and serving (lag stable). Investigate/replace
  the down provider.
- **Verify:** provider health returns to 1, or the healthy provider sustains indexing.

## ApiP95High (warning)

Route p95 > 500ms for 10m.

- **Meaning:** the read API is slow on some route.
- **Likely causes:** missing/ineffective DB index, DB pool saturation, an N+1 query, a heavy
  aggregation on a hot route.
- **Resolution:** open the route's Jaeger traces (pg spans) from the APM dashboard; add indexes or
  cache as needed.
- **Verify:** p95 back under threshold.
