// Shared domain types used across services.
// TODO(Phase 1): flesh out as the schema stabilizes. Kept deliberately small.

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type ContractName = "StakingVault" | "MockToken";

export type StakingEventName = "Staked" | "Withdrawn" | "RewardsClaimed" | "Paused" | "Unpaused";

export interface DeployedAddresses {
  chainId: number;
  stakingVault: Address;
  mockToken: Address;
  deployBlock: number;
}
