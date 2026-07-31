// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TODO(Phase 0): `forge install foundry-rs/forge-std` then:
// import {Test} from "forge-std/Test.sol";
// import {StakingVault} from "../src/StakingVault.sol";
// import {MockToken} from "../src/MockToken.sol";

/// @notice Unit + invariant tests for StakingVault.
/// TODO(Phase 0):
///   - unit tests per function (stake/withdraw/claim, pause reverts, access control).
///   - INVARIANT test: sum(user stakes) == token.balanceOf(vault) under a fuzzed action sequence.
contract StakingVaultTest {
    // contract StakingVaultTest is Test { ... }

    }
