/**
 * sync_state — per-contract / per-job indexing cursors.
 *
 * TODO(Phase 1): @Entity columns (indicative):
 *   sync_key (pk), chain_id, contract, last_block, last_block_hash, updated_at.
 * TODO(Phase 2): kind ('live' | 'backfill' | 'catchup'), target_block (frozen for catch-up).
 */

export {};
