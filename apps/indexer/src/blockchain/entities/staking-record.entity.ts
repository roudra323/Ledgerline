/**
 * staking_records — projection: one row per stake/withdraw action, provenance-keyed.
 *
 * TODO(Phase 1): @Entity columns (indicative):
 *   id (pk), user_address, action ('stake' | 'withdraw'), amount (numeric/bigint-as-string),
 *   total_staked_after, block_number, tx_hash, log_index, created_at.
 *   @Unique(['txHash','logIndex']) so re-applying an event is a no-op upsert.
 */

export {};
