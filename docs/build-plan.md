# Ledgerline — Build Plan

**What you're building:** a bidirectional **fiat ⇄ stablecoin payment rail**. Customers pay fiat,
merchants are settled non-custodially in a stablecoin we issue, merchants can cash out back to fiat.
Two append-only logs feed one double-entry ledger; a chain write path submits transactions
crash-safely; a fault-injection harness proves the failure handling rather than asserting it.

**Why this is not a CRUD app:** two independent sources of truth that must agree and that we control
neither of. Everything interesting — sagas, compensation, idempotency, reconciliation, irreversibility
— falls out of that one fact.

Build order within any block: the working rhythm in [`CLAUDE.md`](../CLAUDE.md), which owns it —
make it work, independent tests, independent review, make it observable, update `progress.md`,
commit.

---

# PART 1 — SCOPE

## 1.1 In scope

**Contracts (Solidity + Foundry)**

- `StableUSD.sol` — a FiatToken-shaped issuer token: 6 decimals, `MASTER_MINTER` / `MINTER` /
  `PAUSER` / `BLACKLISTER` roles, minter allowances, blacklist, pause, EIP-2612 `permit`, EIP-3009
  `transferWithAuthorization` / `receiveWithAuthorization` / `cancelAuthorization`.
- `PaymentProcessor.sol` — `settle`, `settleWithAuthorization`, `refund`, `requestPayout`. A conduit,
  never a vault.
- Both with full unit tests **and invariant suites**.

**Indexer + orchestrator (NestJS)** — the inherited event-sourced core, re-pointed, plus:
`fiat_events` and its dispatcher, the double-entry ledger, three saga aggregates, the outbox, the
chain write path, the compliance gates, the reconcilers.

**Mock PSP (own service)** — HMAC-signed webhooks, deterministic ids, and a **fault-injection API**;
the fault kinds, and the failure mode each one exercises, are listed in
[`apps/mock-psp/README.md`](../apps/mock-psp/README.md).

**Stripe test-mode adapter** behind the same port, contract-tested against `stripe-mock`.

**Read API + admin** — merchant balances, payment history, `/health`, replay, reconciliation reports.

**Demo UI (Next.js, deliberately small)** — a checkout, a merchant balance, a "data as of block N /
lag Xs" badge. It exists to make the demo visceral, not to show off React.

**Load generator** — drives real payment traffic so the dashboards have living data.

## 1.2 Explicit non-goals

Real funds. Mainnet. A licensed money transmitter, VASP or e-money entity. Real KYC or customer PII.
**A peg or collateral mechanism** — this is a payment rail _on top of_ a stablecoin, not an attempt to
design one. Multi-instance ingest scaling. Mempool tracking. Price oracles.

## 1.3 Stack decisions

| Choice                                  | Why                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS + TypeScript                     | DI makes the handler-registry and port/adapter patterns natural                                                                                                                                       |
| viem                                    | Typed ABI inference, first-class `getLogs`, transport fallback, custom-error decoding                                                                                                                 |
| PostgreSQL + TypeORM                    | Deferred constraint triggers, partial unique indexes and `SKIP LOCKED` are the backbone of the whole design ([ADR-0004](decisions/0004-double-entry-ledger.md), [ADR-0005](decisions/0005-outbox.md)) |
| Foundry + Anvil                         | Fast Solidity tests, invariant testing, and `anvil_snapshot`/`anvil_revert` for reorg simulation                                                                                                      |
| prom-client + OTel → Collector → Jaeger | Vendor-neutral; the collector in the middle shows a real telemetry pipeline                                                                                                                           |
| Grafana provisioned from git            | Dashboards in git are reproducible; clicking in a UI is not production                                                                                                                                |

---

# PART 2 — THE STATE MACHINES

Notation: `STATE --[cause]--> STATE`. Causes: `cmd:` API command · `fe:` fiat_event · `oe:` on-chain
event **at confirmation depth** · `rcpt:` transaction receipt (hint only) · `timer:` · `op:` operator.

**Universal rules.**

1. A transition is applied by inserting a `saga_transitions` row. `UNIQUE(saga_type, saga_id,
cause_type, cause_id)` makes replays no-ops.
2. A transition whose `from_status` does not match is classified `IGNORE` / `DEFER` / `ILLEGAL` — never
   silently dropped, never a bare exception.
3. **No saga advances past a value-bearing point on a receipt.** Receipts move `chain_transactions`.
   Sagas move on indexed, confirmed events. ([ADR-0007](decisions/0007-events-not-receipts.md))

## 2.1 On-ramp

```
created            --[cmd:create]-------------> quoted
quoted             --[timer:quote_expiry]-----> expired               (terminal, no money moved)
quoted             --[cmd:submit]-------------> screening_pending
screening_pending  --[cmd:screen_pass]--------> screening_passed
screening_pending  --[cmd:screen_fail]--------> screening_failed      (terminal, no money moved)
screening_passed   --[cmd:authorize]---------> authorized             ledger: none
authorized         --[fe:payment.captured]---> captured               ledger: T1
authorized         --[fe:payment.failed]-----> capture_failed         (terminal)
authorized         --[timer:auth_expiry]-----> capture_failed
captured           --[cmd:reserve_ok]--------> chain_submitted        ledger: T3 + T4
captured           --[cmd:reserve_denied]----> awaiting_liquidity     (parked, NOT failed)
awaiting_liquidity --[timer:retry]-----------> captured
chain_submitted    --[oe:PaymentSettled]-----> chain_confirmed        ledger: T5
chain_submitted    --[rcpt:reverted]---------> refunding              (compensation)
chain_submitted    --[timer:submit_timeout]--> manual_review
chain_confirmed    --[timer:finality]--------> settled                (terminal, happy)

refunding          --[fe:refund.succeeded]---> refunded               ledger: reversal of T1, T3, T4 (fee too)
refunding          --[fe:refund.failed]------> manual_review
chain_submitted    --[oe:Blacklisted(dest)]--> frozen             ledger: compliance.frozen
                      (merchant_payable → frozen_payable; reservation released to token_treasury)
captured / awaiting_liquidity --[oe:Blacklisted(dest)]--> frozen  ledger: none — T3 has not run,
                      so nothing is owed yet; the capture stays in unsettled_capture
```

Postings are [ADR-0018](decisions/0018-ledger-flow-postings.md)'s. T3 is where the merchant becomes
owed (`CR 2000 merchant_payable`); T4 draws the reservation from `1100 token_treasury`, so a float
shortfall is also rejected by the database. Minting is never part of this saga
([ADR-0013](decisions/0013-treasury-float-model.md)): the treasury is topped up by `treasury.mint`,
posted by an operator mint command (core) or the automatic rebalance (Phase 13). A blacklist after T5
has nothing to freeze in the ledger — the tokens are already in the merchant's custody.

## 2.2 Refund (the reverse saga)

A first-class aggregate, not a flag on the intent — there can be N partial refunds with independent
lifecycles.

```
requested              --[cmd:validate]--------> validated
    guards: intent.status IN (chain_confirmed, settled)
            SUM(existing refunds) + amount <= captured_amount_minor
            now() < capture_time + REFUND_WINDOW
requested              --[cmd:reject]----------> rejected
validated              --[cmd:submit_chain]----> chain_refund_submitted   ledger: none (a submission is a hint)
chain_refund_submitted --[oe:PaymentRefunded]--> chain_refund_confirmed
                          ledger: refund.chain_reversed — DR token_treasury / CR fx_clearing:USDX
chain_refund_submitted --[rcpt:reverted]-------> manual_review
chain_refund_confirmed --[cmd:psp_refund]-----> fiat_refund_pending
fiat_refund_pending    --[fe:refund.succeeded]-> completed
                          ledger: refund.fiat_returned — DR fx_clearing:USD + DR merchant_receivable
                                  (shortfall) / CR psp_receivable
fiat_refund_pending    --[fe:refund.failed]----> manual_review
```

**The platform keeps its fee.** The merchant received only the net, so the tokens reclaimed are
capped at the payment's remaining on-chain refundable amount, and any USD the reclaim does not cover
becomes merchant debt in `1300 merchant_receivable` — a full refund always leaves debt equal to the
fee. Reclaimed tokens return to treasury float; nothing is burned. See
[ADR-0018](decisions/0018-ledger-flow-postings.md).

**Chain first, then fiat** — [ADR-0008](decisions/0008-compensation-ordering.md). The revert case is
`manual_review` rather than infinite retry, because the most common cause is _the merchant no longer
holds the tokens_, which is a business dispute, not a technical retry.

## 2.3 Off-ramp / payout

```
requested        --[cmd:validate]-------------> screening_pending
    guards: kyb_status='approved', NOT is_payouts_frozen,
            token.balanceOf(merchant) >= amount (pre-flight hint; the burn enforces it),
            velocity limits OK
requested        --[cmd:reject]---------------> rejected
screening_pending--[cmd:screen_pass]---------> screening_passed
screening_pending--[cmd:screen_fail]---------> manual_review     (funds HELD, not returned)
screening_passed --[cmd:submit_burn]---------> burn_submitted    ledger: none (tokens are still the merchant's)
burn_submitted   --[oe:PayoutRequested]------> burn_confirmed
                    ledger: payout.burned — DR stablecoin_issued (supply shrinks) / CR fx_clearing:USDX
                            + CR rounding_residual; DR fx_clearing:USD / CR merchant_fiat_payable
burn_submitted   --[rcpt:reverted(Paused)]---> blocked_paused
blocked_paused   --[oe:Unpause]--------------> screening_passed          (resume)
burn_submitted   --[rcpt:reverted(Blacklist)]-> blocked_blacklist
burn_confirmed   --[cmd:enqueue_fiat]--------> fiat_queued
                    ledger: none, or DR merchant_fiat_payable / CR merchant_receivable to net a debt
fiat_queued      --[cmd:no_float]------------> awaiting_fiat_liquidity
fiat_queued      --[timer:batch_window]------> batched
batched          --[cmd:submit_batch]--------> fiat_submitted
fiat_submitted   --[fe:payout.paid]----------> fiat_settled
                    ledger: payout.settled — DR merchant_fiat_payable / CR bank_settlement
fiat_submitted   --[fe:payout.failed]--------> fiat_queued        (retryable)
fiat_settled     --[fe:payout.returned]------> returned           (R-code / bounced ACH)
                    ledger: payout.returned — DR bank_settlement / CR merchant_fiat_payable (re-owe)
```

**`burn_confirmed` is the point of no return.** Everything reversible — screening, limits, float
check, simulation — happens strictly before it. If the fiat leg permanently fails after the burn, the
compensation is **not** an automatic re-mint (that changes the reserve math); it is
`merchant_fiat_payable` staying open, plus a manual re-mint path behind an operator command under dual
control.

The full irreversibility map is in [`failure-modes.md`](failure-modes.md).

---

# PART 3 — PHASES

Every phase ends in something demoable. That rule is non-negotiable: the biggest risk to this project
is that it never ships.

| Phase                                  | Content                                                                                                                                                                                                                                | Exit criteria                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Reset**                          | Rename; delete staking stubs; rewrite the docs + `failure-modes.md` + ADRs; keep infra; `assets` + chart-of-accounts migration; `mock-psp` container                                                                                   | `docker compose up` green; migrations run; docs describe the new system                                                                                           |
| **1 — Ledger core**                    | Ledger tables, immutability trigger, deferred balance trigger, `LedgerService.post()`, `splitFee()`, `convert()` with explicit residual                                                                                                | 10k random postings → trial balance 0; `UPDATE` on an entry throws; projection == recomputed; 20 concurrent payouts against float for 10 → **exactly 10** succeed |
| **2 — Contracts**                      | `StableUSD.sol`, `PaymentProcessor.sol`, unit tests, **both invariant suites**, `Deploy.s.sol`, ABI export to `@ledgerline/shared`                                                                                                     | `forge test` green incl. invariants; deployer seeds Anvil deterministically                                                                                       |
| **3 — Chain write path**               | `SignerPort` + both adapters + `SigningPolicyService`; `chain_accounts` / `chain_transactions` / `chain_tx_attempts`; submitter (sign-before-broadcast, simulation, escalation, nonce-hole rule); `ChainTxWatcher`                     | Kill -9 at 5 injected points → exactly one mined tx per intent; nonce-gap test recovers                                                                           |
| **4 — Indexer re-point**               | Handlers for `PaymentSettled`, `PaymentRefunded`, `PayoutRequested`, `Mint`, `Burn`, `Transfer`, `Blacklisted`, `Pause`; the [ADR-0010](decisions/0010-raw-events-partial-unique.md) index fix; `blacklist_status`; `saga_transitions` | Replay determinism passes on the new projections                                                                                                                  |
| **5 — Mock PSP + fiat log**            | `mock-psp` with the fault-injection API; `fiat_events`; webhook endpoint; dispatcher with the `DEFER`/`IGNORE`/`ILLEGAL` classifier; outbox                                                                                            | Every injected fault produces the designed state, proven by test                                                                                                  |
| **6 — On-ramp end-to-end**             | `payment_intents`, idempotency keys, quote/expiry, the full machine, ledger postings, an operator `treasury.mint` command so the treasury has float, web UI happy path                                                                 | One command: create → capture → settle → merchant balance, with a Jaeger trace spanning both logs                                                                 |
| **7 — Reconciliation + observability** | All reconcilers (I1–I9), all metrics, 4 new dashboards, all alerts, all runbook entries, loadgen rewritten                                                                                                                             | Inject a fault → the right alert fires → the runbook resolves it. **Record the demo video here**                                                                  |
| **8 — Refund saga**                    | Refund aggregate, chain-first ordering, partial refunds, the triple overrun guard                                                                                                                                                      | Overrun rejected at all three layers; chargeback-after-payout produces the debt entry                                                                             |
| **9 — Off-ramp**                       | Payout saga: screening → burn → single fiat payout. Float reservation, parking states                                                                                                                                                  | Payout end-to-end; float exhaustion parks rather than fails                                                                                                       |
| **10 — Compliance**                    | Three ports, OFAC snapshot loader, mock chain-risk, gates at all three points, `screening_checks`, velocity limits                                                                                                                     | Fail-closed test; a sanctioned address blocks a payout its capture allowed                                                                                        |
| **11 — Chaos + reorg**                 | Anvil snapshot/revert reorg suite; crash-injection suite; the `RpcDisagreement` cross-check                                                                                                                                            | Reorg within depth self-heals; beyond depth → `manual_review` + alert                                                                                             |
| **12 — Stripe adapter**                | Real test-mode adapter behind the port; contract tests against `stripe-mock`; manual e2e via the Stripe CLI. **Not in CI**                                                                                                             | The same saga suite passes against both adapters                                                                                                                  |
| **13 — Stretch**                       | Payout **batching**, **automatic** float rebalancing (the operator mint is core, Phase 6), EIP-3009 gasless payer flow in the UI, Loki                                                                                                 | —                                                                                                                                                                 |

## 3.1 Cut order

Cut from the bottom, never the middle:

1. **Phase 13 entirely.** Batching and automatic float rebalancing have the lowest ratio of insight to effort. The operator mint stays: without it the on-ramp has no float to settle from (ADR-0013).
   The _design_ in these docs is worth ~90% of the credit of building them.
2. **Phase 12** down to the port plus a `stripe-mock` contract test, with a written "how the port maps
   to Stripe's API" section.
3. **Phase 10** down to `IssuerBlacklistPort` (the real one) plus correct gate placement. Drop the
   OFAC loader.
4. **Phase 9** to designed-not-built, documented with the state machine above.
5. **`KmsSigner`** down to the interface plus a README paragraph.

**Never cut: 1, 3, 5, 6, 7, 11.** The ledger, the write path, fault injection, one end-to-end saga,
observability and the chaos suite _are_ the project.

## 3.2 Effort

As fully specified, 6–12 months part-time. The never-cut set is roughly **3–4 months part-time** and
already produces a complete, coherent, demoable system with more than enough depth to carry an
interview end to end.

---

# PART 4 — TESTING

The load-bearing tests, in rough order of value:

1. **Crash injection on the write path** — a `CrashPoint` enum with 6–8 points around
   sign/persist/broadcast/receipt/confirm; kill and restart at each; assert exactly-once mining.
   _The highest-value test in the repo._
2. **Trial-balance property test** — `fast-check` over random valid operation sequences; per-asset
   balance and no illegal negatives after every commit.
3. **Idempotency at three levels** — the same webhook 50× concurrently → one ledger transaction; the
   same `POST` + key 50× → one intent and identical responses; the same `intent_key` twice → one
   mined tx (and if both land, the second reverts and the saga still ends correct).
4. **Replay determinism** — full workload → snapshot every projection → truncate → rebuild →
   deep-equal. Inherited, and still the best test in the design.
5. **Saga compensation matrix** — one row per `(saga_type, failure_injection_point)`, asserting the
   terminal state, the exact set of ledger transaction kinds posted, and the net position of every
   account. This table _is_ Part 2, executable.
6. **Fault injection via the mock PSP** — one test per injectable fault, asserting the designed
   response from `failure-modes.md`.
7. **Reorg suite** — within depth (self-heals via reversals) and beyond depth (`manual_review` +
   alert).
8. **Foundry invariants** — both suites, bounded handler, ghost accounting; fixed seed in CI plus a
   nightly random-seed job.
9. **Concurrency** — 20 payouts against float for 10 → exactly 10 succeed, 10 park.
10. **Immutability** — three lines asserting `UPDATE ledger_entries` and `DELETE FROM raw_events`
    throw. Proves a load-bearing claim.
11. **Migration round-trip** — every migration up/down/up on a scratch DB in CI.
12. **`PaymentGatewayPort` contract suite** — one shared suite run against MockPSP and `stripe-mock`.
    This is what proves the port is not a toy, far more cheaply than a full Stripe e2e.

**CI jobs:** `lint` (eslint, `docs:check` and `typecheck`) · `contracts` · `unit` · `integration` (a
GitHub Actions `postgres:17` service and a throwaway database per run; Anvil joins when Part 4's
indexer tests need it) · `docker-build`. The Stripe e2e is a manually-dispatched workflow only — test-mode Stripe in
CI means network flakiness, secrets in Actions, webhook tunnelling and rate limits, for signal that is
90% obtainable from `stripe-mock`.

---

# PART 5 — RISKS

| Risk                                              | Mitigation                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Never ships** (the dominant risk)               | Every phase demoable; explicit cut list; never-cut set identified                                                    |
| Off-ramp doubles the surface for ~20% new insight | Phase 9 is a thin single-payout path; batching deferred to Phase 13, the first thing cut                             |
| Compliance becomes theatre                        | Three ports, a pinned public-domain list, honest disclaimer. No rules DSL, no risk model, no compliance dashboard    |
| Custody becomes theatre                           | Build the policy layer, not a fake vault. [ADR-0011](decisions/0011-key-management.md)                               |
| Observability configured but empty                | The load generator is a first-class deliverable, not an afterthought                                                 |
| Container sprawl (13 → 15)                        | `anvil2` must earn its keep as the pre-payout RPC cross-check (failure mode B10). If that check is cut, cut `anvil2` |
| "Works on my machine"                             | Compose is the only supported run mode from Phase 6; CI runs integration on fresh containers                         |

---

# PART 6 — QUICK REFERENCE

```bash
make install          # pnpm install + forge install
make chain            # anvil + deploy + write addresses to packages/shared
make up               # core stack
make demo             # everything incl. loadgen + mock-psp faults
make test             # unit + property
make test-integration # Postgres from docker compose; a throwaway database per run

# drive a payment by hand
curl -XPOST localhost:3001/payment-intents \
  -H 'Idempotency-Key: demo-1' \
  -d '{"merchantId":"…","fiatAsset":"USD","fiatAmountMinor":"10000"}'

# inject a fault
curl -XPOST localhost:4001/_fault -d '{"kind":"drop_webhook","count":1}'
```
