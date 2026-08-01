# ADR-0012 — Three screening ports, not one `isBlocked()`

**Status:** Accepted

## Context

"Is this counterparty allowed?" looks like one question. It is three, and collapsing them is the
mistake most payment demos make.

- **Sanctions screening** matches _names_ against government lists, fuzzily, with false positives.
  It is advisory, expensive, slow, and its answer is a policy decision.
- **Chain-risk analytics** scores _addresses_ by exposure. Also advisory, also probabilistic.
- **The issuer blacklist** is a boolean on the token contract. It is authoritative, free (it is a
  contract call), and if you ignore it your transaction simply reverts.

Different lists, different refresh cadences, different query semantics, different failure policies.
One interface hides all of that.

## Decision

Three ports, three adapters:

| Port                     | Demo adapter                                                                                                                                                                            | Real shape                                  | Data                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------- |
| `SanctionsScreeningPort` | Pinned **OFAC SDN snapshot** committed to the repo (US government public domain, so this is legitimate) + a loader + fuzzy name match (Jaro-Winkler over aliases, documented threshold) | ComplyAdvantage, Refinitiv                  | Names, DOBs, countries     |
| `ChainRiskPort`          | `MockChainRiskAdapter` — seeded deny-list plus a deterministic pseudo-score derived from the address bytes, with injectable latency and failure                                         | Chainalysis, TRM Labs                       | Addresses, exposure scores |
| `IssuerBlacklistPort`    | **Real** — `StableUSD.isBlacklisted()` via viem, plus a `blacklist_status` projection built from indexed `Blacklisted`/`UnBlacklisted` events                                           | Circle's and Tether's actual on-chain lists | Addresses                  |

Screening is a **gate transition inside the saga**, never a batch job, and it runs at three points:

1. `pre_credit` — after capture, before any token movement or merchant credit
2. `pre_payout` — immediately before the burn, **re-run from scratch**
3. `periodic` — a cron re-screening of active counterparties that can retroactively freeze an account

Every check writes an immutable `screening_checks` row carrying `list_version` and `list_sha256`, so
a past decision is explainable and replayable **against the list as it was**.

**Failure policy: fail closed.** If a screening provider is unavailable, the saga parks in
`screening_pending` and retries. We never credit or pay out on an unavailable screening result.

## Alternatives considered

| Alternative                                          | Why it lost                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One `CompliancePort.isBlocked(subject): boolean`     | Hides that a blacklist hit is a hard on-chain failure while a sanctions hit is a policy decision, and forces one failure policy onto three services with different availability characteristics.                         |
| Screen once at capture, reuse the decision at payout | Lists change. An address sanctioned between capture and payout must block the payout — that is the entire reason the `pre_payout` gate exists (failure mode D3).                                                         |
| Batch screening as a post-processing job             | Screening after crediting is not screening. The whole control depends on being a gate.                                                                                                                                   |
| Fail open when the vendor is down                    | The usual availability instinct, and wrong here: the cost of a wrong _allow_ is unbounded and possibly criminal; the cost of a delay is a support ticket. Asymmetric costs mean asymmetric defaults.                     |
| Build a rules engine / DSL / risk-scoring model      | The fastest path to theatre. A hand-rolled rules DSL with no real data behind it actively _loses_ credibility. Three ports, a real on-chain integration, correct gate placement and an honest disclaimer are worth more. |
| Skip compliance entirely as a non-goal               | Then the payment saga is missing the gate that most shapes its real-world state machine, and the `frozen` / `blocked_blacklist` states have no cause.                                                                    |

## Consequences

**Good.** One of the three integrations is _real_. `IssuerBlacklistPort` calls an actual contract and
consumes actual events, and a blacklisted address genuinely reverts the settlement (failure mode
B16). That is not a mock.

**Good.** `screening_checks` with list versioning means "why was this allowed in March?" is
answerable, which is the actual regulatory ask.

**Good.** The fail-closed policy produces a demonstrable behaviour: kill the screening adapter, watch
sagas park rather than leak.

**Bad.** Fail-closed means a screening outage is a full payment outage. That is the correct trade and
it is still an outage; the runbook says so, and `ScreeningUnavailable` alerts on it.

**Bad.** Fuzzy name matching over the SDN list will produce false positives, and we have no
disposition workflow beyond `manual_review`. Real programs have analyst queues. Noted as a limit, not
simulated.

## Honesty clause

Reproduced in the README verbatim:

> This is not a licensed money transmitter, VASP, or e-money institution, and nothing here
> constitutes a compliance program. The screening layer exists to demonstrate _where_ screening
> belongs in a payment saga and _what its failure modes are_. It uses a pinned public-domain OFAC SDN
> snapshot and a deterministic mock analytics adapter. There is no real KYC vendor, no real customer
> PII, no real sanctions determination, and no audit trail any regulator would accept. What is real:
> the gate placement, the fail-closed policy, the immutable versioned `screening_checks` audit, and
> the on-chain blacklist integration.
