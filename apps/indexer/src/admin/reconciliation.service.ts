/**
 * ReconciliationService — the trust metric. Cron job comparing on-chain truth vs indexed state.
 *
 * TODO(Phase 2): eth_call StakingVault.totalStaked() vs SUM(user_balances.staked_amount);
 *   emit chainstake_reconciliation_drift_wei (must be 0). Non-zero drift for 10m pages on-call.
 */

export {};
