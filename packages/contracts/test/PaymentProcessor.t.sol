// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev TODO(Part 2): unit tests per function, plus PaymentProcessor.invariants.t.sol.
///      The two tests that matter most, because they are the last line of defence against a
///      server bug costing real money:
///        - settle() twice with the same paymentId reverts PaymentAlreadySettled
///        - refunds summing past the capture revert RefundExceedsCapture
contract PaymentProcessorTest {}
