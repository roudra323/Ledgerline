/**
 * ReplayService — rebuilds projections deterministically from raw_events. The event-sourcing payoff.
 *
 * TODO(Phase 2) rebuild(projections):
 *   1. pause the dispatch loop.
 *   2. truncate the target projection tables.
 *   3. stream raw_events ORDERED by (block_number, log_index) through the handlers.
 *   4. resume dispatch.
 *   emit span replay.rebuild{projections, event_count}.
 * Golden test (Phase 7): ingest -> snapshot -> truncate -> replay -> deep-equal.
 */

export {};
