/**
 * IndexerService — the single parameterized indexing loop (backfill = live = catch-up).
 *
 * runChunk(syncKey) is the heart of the system. Non-negotiables from day one (Phase 1):
 *   1. sort logs by (block_number, log_index) before anything else.
 *   2. cursor-advance + raw_events inserts happen in ONE database transaction.
 *   3. raw_events insert uses ON CONFLICT DO NOTHING (idempotency backbone).
 *   4. empty ranges still advance the cursor.
 *   5. never read past (head - CONFIRMATIONS).
 *
 * TODO(Part 4): implement runChunk + dispatch to handlers via EventRegistry.
 * TODO(Part 4): adaptive chunking, reorg guard hook, per-event failure isolation.
 *
 * Scheduler: a @nestjs/schedule 5s tick calls runChunk with a per-syncKey in-process mutex
 * so ticks never overlap for the same key.
 */

export {};
