/**
 * ComplianceModule — screening gates (docs/decisions/0012-compliance-ports.md).
 *
 * Three ports, because these are genuinely three different problems with different lists, refresh
 * cadences, query semantics and failure policies:
 *   - SanctionsScreeningPort  name-fuzzy, advisory, expensive   (pinned public-domain OFAC snapshot)
 *   - ChainRiskPort           address-scored, advisory          (deterministic mock adapter)
 *   - IssuerBlacklistPort     address-exact, AUTHORITATIVE      (real: StableUSD.isBlacklisted())
 *
 * Screening is a GATE TRANSITION inside the saga, never a batch job, at three points:
 *   pre_credit -> pre_payout (re-run from scratch, never reuse) -> periodic.
 *
 * FAIL CLOSED. Never credit or pay out on an unavailable screening result. The cost of a wrong
 * allow is unbounded; the cost of a delay is a support ticket.
 *
 * TODO(Phase 10): the three ports, ScreeningCheck entity (immutable, with list_version +
 *   list_sha256 so a past decision is replayable against the list as it was), velocity limits.
 * TODO(Phase 4): blacklist_status projection from indexed Blacklisted/UnBlacklisted events.
 */

export {};
