/**
 * indexer_failures — dead-letter record for events whose handler threw.
 *
 * TODO(Phase 2): @Entity columns (indicative):
 *   id (pk), raw_event_id (fk), event_name, user_address, error, attempts, next_retry_at,
 *   status ('failed' | 'retrying' | 'resolved'), created_at, updated_at.
 * The retry job re-runs a user's failed events IN ORDER, with capped attempts, and alerts
 * on funds events (chainstake_events_failed_total).
 */

export {};
