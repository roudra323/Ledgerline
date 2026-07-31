/**
 * user_balances — projection: current staked balance per user.
 *
 * ALWAYS recomputed by aggregation over staking_records (order-independent). Never mutated by
 * incrementing a running total — that would break replay determinism and reorg safety.
 *
 * TODO(Phase 1): @Entity columns (indicative):
 *   user_address (pk), staked_amount (numeric), last_updated_block, updated_at.
 */

export {};
