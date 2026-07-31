/**
 * raw_events — append-only source of truth for every decoded on-chain event.
 *
 * The idempotency backbone: UNIQUE(chain_id, tx_hash, log_index). Inserts use
 * ON CONFLICT DO NOTHING. Projections are rebuilt from this table by the ReplayService.
 *
 * TODO(Phase 1): TypeORM @Entity with columns (indicative):
 *   id (pk), chain_id, block_number, block_hash, tx_hash, log_index, contract, event_name,
 *   args (jsonb), status ('processed' | 'failed' | 'orphaned'), created_at.
 *   @Unique(['chainId','txHash','logIndex']); index on (block_number, log_index).
 */

export {};
