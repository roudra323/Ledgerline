# ADR-0009 — On-chain only what must survive a compromised server

**Status:** Accepted

## Context

We control both the contracts and the servers. That makes it tempting either to put everything
on-chain ("it's trustless!") or nothing beyond a token ("the chain is just a ledger"). Both are
lazy. Each thing we put on-chain costs gas, costs upgrade flexibility, and becomes permanently
public.

## Decision

> **Put on-chain only what must be enforced against an adversary who controls our servers.**

| On-chain                                         | Off-chain                             | Why                                                                                    |
| ------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------- |
| Token issuance, transfer, burn                   | —                                     | It is where the asset lives                                                            |
| Blacklist, pause                                 | —                                     | A regulatory kill-switch must be enforceable at the asset, not at our API              |
| Payment-id idempotency (`PaymentAlreadySettled`) | —                                     | A server bug here costs real money                                                     |
| Refund cap (`RefundExceedsCapture`)              | —                                     | Same                                                                                   |
| Fee _charged_, emitted per settlement            | Fee _policy_, tiers, promotions       | Pricing changes weekly; consensus should not                                           |
| —                                                | Saga orchestration, retries, batching | Cheap, mutable, needs no adversarial guarantee                                         |
| —                                                | FX rates, quote expiry                | An oracle would be theatre at 1:1; a real multi-currency rail needs one, and we say so |
| —                                                | **KYC/sanctions data, PII — always**  | Never put personal data on a public ledger. Ever                                       |

Two on-chain invariants are load-bearing for the entire system:

- **`settle` reverts `PaymentAlreadySettled` if the payment id exists.** A duplicate submission from
  a crashed-and-restarted submitter can never double-pay a merchant. Off-chain idempotency
  ([ADR-0005](0005-outbox.md), [ADR-0006](0006-chain-write-path.md)) is defence-in-depth _on top of_
  this, not the primary mechanism.
- **`refunded + amount <= payments[id].amount`.** Partial-refund overrun is impossible even if every
  off-chain check is wrong.

`PaymentProcessor` holds no balance: `token.balanceOf(processor) == 0` after every action. It is a
conduit, never a vault — one invariant that eliminates a whole class of stuck-funds bugs.

## Alternatives considered

| Alternative                                          | Why it lost                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Put the fee schedule on-chain                        | Pricing is a business decision that changes on a weekly cadence. Putting it in consensus means a deployment (or an upgrade proxy, and its own risk) every time marketing runs a promotion. Emit the fee _charged_ so the event is self-describing; keep the _policy_ off-chain. |
| Put merchant registration and KYB status on-chain    | Publishes counterparty relationships permanently, for no adversarial benefit — we are the only party who acts on that status.                                                                                                                                                   |
| Put refund logic entirely off-chain                  | The overrun check is a direct money-loss vector. It belongs in the place that a compromised or buggy server cannot bypass.                                                                                                                                                      |
| An upgradeable proxy for both contracts              | Real projects need it. Here it adds storage-layout hazards and an admin key that becomes the most valuable thing in the system, in exchange for flexibility a demo does not need. Contracts are immutable; redeploy on Anvil is free.                                           |
| Keep `PaymentProcessor` custodial (holding balances) | Makes a lot of edge cases _easier_ — you can just move an internal balance — which is exactly why it is wrong for this project. Non-custodial delivery is what makes irreversibility real.                                                                                      |
| A single monolithic contract                         | Conflates issuance (a regulated function with a minter role) with payment routing (an operational function). Two contracts means two role sets and a genuinely smaller blast radius per key.                                                                                    |

## Consequences

**Good.** The security argument is short enough to defend: _"these two reverts are the only things
standing between a server bug and a double payment, and they are on-chain."_

**Good.** Off-chain logic can be fixed with a deploy rather than a migration. Everything that changes
frequently is in the layer where change is cheap.

**Good.** No PII touches the chain, so there is no future regret and no deletion problem that cannot
be solved.

**Bad.** Non-custodial delivery means several failure modes have no code compensation at all — a
delivered token cannot be recalled (see `failure-modes.md`, irreversibility map). We chose the harder
model deliberately, because the alternative hides the interesting problem.

**Bad.** Immutable contracts mean a bug in `PaymentProcessor` requires a redeploy and a migration of
`payments` state. On Anvil this is free; the ADR notes it as a real limitation of the choice rather
than pretending it is not.
