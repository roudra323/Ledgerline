import type { DeployedAddresses } from "./types/index.js";

/**
 * Deployed contract addresses.
 *
 * TODO(Phase 2): the deployer writes `addresses.local.json` (git-ignored) at chain boot; load and
 * validate it here. This placeholder keeps the type contract stable until then.
 */
export const addresses: DeployedAddresses = {
  chainId: 31337,
  stableUsd: "0x0000000000000000000000000000000000000000",
  paymentProcessor: "0x0000000000000000000000000000000000000000",
  deployBlock: 0,
};
