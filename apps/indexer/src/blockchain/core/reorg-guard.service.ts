/**
 * ReorgGuardService — protects projections from chain reorganizations.
 *
 * TODO(Part 4):
 *   - confirmation depth: never process past (head - CONFIRMATIONS).
 *   - hash continuity: verify parentHash of the next block matches the last persisted block hash.
 *   - on divergence: orphan affected raw_events, rewind the cursor, replay the affected range —
 *     then, for anything already acted on, append a compensating saga transition and post a
 *     reversing ledger transaction (docs/architecture.md §2.9). Two decisions are open and belong to
 *     Block 4.4: how the app role marks a row orphaned when UPDATE is revoked on the log tables, and
 *     keying a re-settlement's cause on the raw_events row id so it does not collide with the
 *     reversed posting (ARCHITECTURE-WALKTHROUGH.md §14).
 *   - emit ledgerline_reorg_rollbacks_total and ledgerline_reorg_depth_blocks.
 * Test with Anvil anvil_snapshot / anvil_revert + re-mine to force divergent hashes.
 */

export {};
