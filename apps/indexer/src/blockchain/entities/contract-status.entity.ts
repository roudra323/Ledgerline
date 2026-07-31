/**
 * contract_status — projection: latest paused/unpaused + owner-level state per contract.
 *
 * TODO(Phase 2): @Entity columns (indicative):
 *   contract_address (pk), paused (bool), last_event_block, updated_at.
 * Fed by Paused / Unpaused handlers.
 */

export {};
