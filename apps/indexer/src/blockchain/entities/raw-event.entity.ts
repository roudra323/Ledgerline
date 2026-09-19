/**
 * raw_events — append-only source of truth for every decoded on-chain event.
 *
 * Half of the idempotency backbone (the other half is `fiat_events`). Inserts use
 * ON CONFLICT DO NOTHING. Projections are rebuilt from this table by the ReplayService.
 *
 * The uniqueness rule is a PARTIAL index, not a total one — see
 * docs/decisions/0010-raw-events-partial-unique.md:
 *
 *   CREATE UNIQUE INDEX raw_events_canonical_uk
 *     ON raw_events (chain_id, tx_hash, log_index) WHERE NOT is_orphaned;
 *
 * A total unique key silently swallows the re-inclusion of a reorged transaction, leaving a row
 * with a stale orphaned block_number/block_hash that then poisons confirmation-depth math for a
 * payment. The partial index lets the orphaned copy and the canonical copy coexist.
 *
 * EVERY read must filter `WHERE NOT is_orphaned` — reads go through the repository method that
 * applies it, not through the raw table.
 *
 * TODO(Part 4): TypeORM @Entity with columns (indicative):
 *   id (pk), chain_id, block_number, block_hash, tx_hash, log_index, contract, event_name,
 *   args (jsonb), status ('processed' | 'failed'), is_orphaned, orphaned_at, created_at.
 *   Partial unique index above; index on (chain_id, block_hash); index on (block_number, log_index).
 */

export {};
