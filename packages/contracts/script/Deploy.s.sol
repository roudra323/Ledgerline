// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TODO(Phase 0): import {Script} from "forge-std/Script.sol"; import contracts.

/// @notice Deploys MockToken + StakingVault to the target RPC and writes the resulting addresses
///         + deploy block to packages/shared/src/addresses.local.json (consumed by the indexer).
/// TODO(Phase 0):
///   - vm.startBroadcast(); deploy MockToken; deploy StakingVault(mockToken); stopBroadcast.
///   - vm.writeJson(...) the addresses so `make chain` produces a ready-to-index environment.
contract DeployScript {
    // contract DeployScript is Script { function run() external { ... } }

    }
