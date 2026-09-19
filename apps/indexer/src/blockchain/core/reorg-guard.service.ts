/**
 * ReorgGuardService — protects projections from chain reorganizations.
 *
 * TODO(Part 4):
 *   - confirmation depth: never process past (head - CONFIRMATIONS).
 *   - hash continuity: verify parentHash of the next block matches the last persisted block hash.
 *   - on divergence: orphan affected raw_events, rewind the cursor, replay the affected range.
 *   - emit ledgerline_reorg_rollbacks_total and ledgerline_reorg_depth_blocks.
 * Test with Anvil anvil_snapshot / anvil_revert + re-mine to force divergent hashes.
 */

export {};
