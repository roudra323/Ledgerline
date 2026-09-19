/**
 * ReplayService — rebuilds projections deterministically from the two append-only logs. The
 * event-sourcing payoff.
 *
 * TODO(Part 4) rebuild(projections):
 *   1. pause the dispatch loop.
 *   2. truncate the target projection tables.
 *   3. stream BOTH logs through their handlers — raw_events WHERE NOT is_orphaned, ordered by
 *      (block_number, log_index), and fiat_events — in one deterministic merge order. Projections
 *      such as saga status depend on both, so replaying raw_events alone cannot rebuild them.
 *   4. resume dispatch.
 *   emit span replay.rebuild{projections, event_count}.
 * Golden test (Part 4's exit criterion): ingest -> snapshot -> truncate -> replay -> deep-equal.
 */

export {};
