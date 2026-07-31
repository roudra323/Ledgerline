// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TODO(Phase 0): `forge install OpenZeppelin/openzeppelin-contracts` then uncomment:
// import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
// import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title StakingVault
/// @notice Users stake an ERC20 token, accrue simple linear rewards, and withdraw.
/// @dev Events carry FULL context (amount + resulting total) — a deliberate design choice so the
///      off-chain indexer's handlers are self-contained and deterministic.
contract StakingVault {
    // ── Events (the indexer's source of truth) ───────────────────────────────
    event Staked(address indexed user, uint256 amount, uint256 totalStaked);
    event Withdrawn(address indexed user, uint256 amount, uint256 totalStaked);
    event RewardsClaimed(address indexed user, uint256 amount, uint256 totalStaked);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    // ── State ────────────────────────────────────────────────────────────────
    // TODO(Phase 0): IERC20 stakingToken; mapping(address => uint256) stakedOf;
    //                uint256 public totalStaked; reward accounting; owner; paused.

    // ── Actions ──────────────────────────────────────────────────────────────
    function stake(uint256 amount) external {
        // TODO(Phase 0): pull tokens, update stakedOf/totalStaked, emit Staked.
    }

    function withdraw(uint256 amount) external {
        // TODO(Phase 0): update accounting, transfer out, emit Withdrawn.
    }

    function claimRewards() external {
        // TODO(Phase 0): accrue linear rewards, transfer, emit RewardsClaimed.
    }

    // ── Owner controls ───────────────────────────────────────────────────────
    function pause() external {
        // TODO(Phase 0): onlyOwner; emit Paused.
    }

    function unpause() external {
        // TODO(Phase 0): onlyOwner; emit Unpaused.
    }

    // ── Views (used by the reconciliation audit) ─────────────────────────────
    // uint256 public totalStaked;  // reconciliation compares this vs SUM(user_balances).
}
