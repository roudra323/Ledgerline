/**
 * WithdrawnHandler — projects `Withdrawn(address user, uint256 amount, uint256 totalStaked)`.
 *
 * TODO(Phase 1): symmetric to StakedHandler — provenance-keyed upsert into staking_records +
 *   aggregate-recompute user_balances. Deterministic, replay-safe.
 *
 * TODO(Phase 2+): add RewardsClaimedHandler and Paused/Unpaused (contract_status). The
 *   RewardsClaimed handler is the one to temporarily disable when demoing catch-up jobs.
 */

export {};
