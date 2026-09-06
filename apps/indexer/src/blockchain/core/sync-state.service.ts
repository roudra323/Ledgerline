/**
 * SyncStateService — reads/advances per-contract cursors in the `sync_state` table.
 *
 * TODO(Part 4): getCursor(syncKey), advanceCursor(syncKey, toBlock, lastHash) — cursor advance
 *   MUST happen in the same transaction as the raw_events insert (see IndexerService.runChunk).
 * TODO(Part 4): support kind='live' | 'backfill' | 'catchup' rows with frozen target_block;
 *   auto-create catch-up rows from the registry diff on boot.
 */

export {};
