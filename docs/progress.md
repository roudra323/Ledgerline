# Ledgerline — Progress Tracker

> **Update this file at the end of every block, in the same commit as the work.**
> A tracker updated later is a tracker nobody trusts.

**Overall: 10 / 76 blocks complete** — Phase 0 done, Part 1 in progress.

```
Phase 0  ████████████████████  9/9    ✅ complete
Part 1   ██░░░░░░░░░░░░░░░░░░  1/9    ← YOU ARE HERE
Part 2   ░░░░░░░░░░░░░░░░░░░░  0/8
Part 3   ░░░░░░░░░░░░░░░░░░░░  0/8
Part 4   ░░░░░░░░░░░░░░░░░░░░  0/5
Part 5   ░░░░░░░░░░░░░░░░░░░░  0/6
Part 6   ░░░░░░░░░░░░░░░░░░░░  0/6
Part 7   ░░░░░░░░░░░░░░░░░░░░  0/5
Parts 8–13                     0/20   (optional — see cut list)
```

**Next action:** Block 1.1 — `apps/indexer/src/ledger/money.ts`

**Minimum shippable point:** end of **Part 7**. Everything after that is depth.

---

## Status key

| Symbol | Meaning                                  |
| ------ | ---------------------------------------- |
| ☐      | Not started                              |
| ▶      | In progress                              |
| ✅     | Done — code **and** its test, verified   |
| ⏭      | Deliberately cut (record why in the log) |

**A block is only ✅ when:** the code works, its test passes, `pnpm lint && pnpm typecheck` are
clean, the `Verify` step in [`implementation-guide.md`](implementation-guide.md) was actually run,
and you can answer the block's question in [`learning-path.md`](learning-path.md).

---

## Phase 0 — Reset ✅

Complete. The pivot from staking to a payment rail.

| #   | What                                               | Status | Verified by                                              |
| --- | -------------------------------------------------- | ------ | -------------------------------------------------------- |
| 0.1 | Rename ChainStake → Ledgerline                     | ✅     | `grep -ri chainstake` → clean; lockfile regenerated      |
| 0.2 | `docs/architecture.md` rewritten                   | ✅     | Two-log + double-entry thesis                            |
| 0.3 | `docs/failure-modes.md` (~50 entries)              | ✅     | 4 groups + irreversibility map                           |
| 0.4 | 14 ADRs in `docs/decisions/`                       | ✅     | Each with alternatives and why they lost                 |
| 0.5 | build-plan / observability / runbook / conventions | ✅     | 25 alerts, ~45 metrics documented                        |
| 0.6 | `CLAUDE.md` + `README.md`                          | ✅     | New golden rules, honest disclaimers                     |
| 0.7 | Staking stubs deleted, new modules scaffolded      | ✅     | `ledger/ sagas/ fiat/ chain-writer/ compliance/ outbox/` |
| 0.8 | `assets` + chart-of-accounts migration             | ✅     | Up/down/up round-trip; 3 assets, 16 accounts             |
| 0.9 | mock-psp compose service + latent fixes            | ✅     | `compose config` valid; `promtool` 25 rules OK           |

**Verified:** `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm format:check` ✅ · `forge build` ✅ ·
`nest build` → `dist/main.js` ✅ · migration round-trip ✅ · 6 constraint assertions ✅

---

## Part 1 — The ledger

_The foundation. Nothing works if this is wrong._

| Block | What                                              | Status | Date       | Commit  | Notes                                                                                                          |
| ----- | ------------------------------------------------- | ------ | ---------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| 1.0   | App boots, connects to Postgres                   | ✅     | 2026-08-03 | 2a42ce9 | zod env fails loud at boot; `/health` does a real `SELECT 1`; `incremental:false` fixed a silent stale `dist/` |
| 1.1   | `money.ts` — integer money, `splitFee`, `convert` | ☐      |            |         |                                                                                                                |
| 1.2   | Double-entry concept _(no code)_                  | ☐      |            |         |                                                                                                                |
| 1.3   | Ledger tables + entities                          | ☐      |            |         |                                                                                                                |
| 1.4   | Deferred balance trigger                          | ☐      |            |         |                                                                                                                |
| 1.5   | Immutability trigger + `reverses_id`              | ☐      |            |         |                                                                                                                |
| 1.6   | `LedgerService.post()` — the single writer        | ☐      |            |         |                                                                                                                |
| 1.7   | Balances projection + row lock                    | ☐      |            |         |                                                                                                                |
| 1.8   | Trial-balance property test                       | ☐      |            |         |                                                                                                                |

**Part 1 exit:** 10k random postings → trial balance exactly 0 · `UPDATE ledger_entries` throws ·
20 concurrent payouts against float for 10 → exactly 10 succeed.

---

## Part 2 — Contracts

| Block | What                                     | Status | Date | Commit | Notes |
| ----- | ---------------------------------------- | ------ | ---- | ------ | ----- |
| 2.0   | `forge install` forge-std + OpenZeppelin | ☐      |      |        |       |
| 2.1   | `StableUSD` core, `decimals() = 6`       | ☐      |      |        |       |
| 2.2   | Minter allowance                         | ☐      |      |        |       |
| 2.3   | Blacklist + pause                        | ☐      |      |        |       |
| 2.4   | `settle` + `PaymentAlreadySettled`       | ☐      |      |        |       |
| 2.5   | Refund cap + `RefundExceedsCapture`      | ☐      |      |        |       |
| 2.6   | Both invariant suites                    | ☐      |      |        |       |
| 2.7   | Deploy script + ABI export               | ☐      |      |        |       |

**Part 2 exit:** `forge test` green including invariants · deployer seeds Anvil deterministically ·
ABIs generated into `packages/shared` (**hard gate — Parts 3 and 4 cannot start without this**).

---

## Part 3 — The chain writer

_The hardest part. Take your time._

| Block | What                                  | Status | Date | Commit | Notes |
| ----- | ------------------------------------- | ------ | ---- | ------ | ----- |
| 3.1   | Understand the problem _(no code)_    | ☐      |      |        |       |
| 3.2   | Nonce allocation under a row lock     | ☐      |      |        |       |
| 3.3   | `SignerPort` + `SigningPolicyService` | ☐      |      |        |       |
| 3.4   | **Sign → save → commit → broadcast**  | ☐      |      |        |       |
| 3.5   | Pre-flight simulation                 | ☐      |      |        |       |
| 3.6   | Receipt watcher (reverts only)        | ☐      |      |        |       |
| 3.7   | Gas escalation + oldest-nonce rule    | ☐      |      |        |       |
| 3.8   | Crash-injection test                  | ☐      |      |        |       |

**Part 3 exit:** kill the process at 5+ injected points → **exactly one mined transaction per
intent**, every time. Nonce-gap test recovers.

---

## Part 4 — The indexer

| Block | What                                        | Status | Date | Commit | Notes |
| ----- | ------------------------------------------- | ------ | ---- | ------ | ----- |
| 4.1   | `raw_events` + **partial** unique index     | ☐      |      |        |       |
| 4.2   | Chunk loop + adaptive chunking              | ☐      |      |        |       |
| 4.3   | Handler registry (crashes at boot on dupes) | ☐      |      |        |       |
| 4.4   | Reorg guard + compensating reversals        | ☐      |      |        |       |
| 4.5   | Replay service                              | ☐      |      |        |       |

**Part 4 exit:** replay determinism test passes — snapshot, wipe projections, rebuild, deep-equal.

---

## Part 5 — The fiat rail

| Block | What                               | Status | Date | Commit | Notes |
| ----- | ---------------------------------- | ------ | ---- | ------ | ----- |
| 5.1   | mock-psp + fault-injection API     | ☐      |      |        |       |
| 5.2   | `fiat_events` + three-line webhook | ☐      |      |        |       |
| 5.3   | HMAC over the raw body             | ☐      |      |        |       |
| 5.4   | Dispatcher + IGNORE/DEFER/ILLEGAL  | ☐      |      |        |       |
| 5.5   | Outbox + `SKIP LOCKED` worker      | ☐      |      |        |       |
| 5.6   | One test per injected fault        | ☐      |      |        |       |

**Part 5 exit:** every armed fault produces its designed state, proven by test.

---

## Part 6 — The on-ramp

_Everything connects. Needs Parts 1–5 complete._

| Block | What                                        | Status | Date | Commit | Notes |
| ----- | ------------------------------------------- | ------ | ---- | ------ | ----- |
| 6.1   | `payment_intents` + frozen price snapshot   | ☐      |      |        |       |
| 6.2   | Idempotency keys (incl. the `422` case)     | ☐      |      |        |       |
| 6.3   | `saga_transitions` + cause-keyed uniqueness | ☐      |      |        |       |
| 6.4   | Wire the on-ramp end to end                 | ☐      |      |        |       |
| 6.5   | Read API                                    | ☐      |      |        |       |
| 6.6   | UI + "data as of block N" badge             | ☐      |      |        |       |

**Part 6 exit:** one command → create → capture → settle → merchant credited, with a Jaeger trace
spanning both logs.

---

## Part 7 — Reconciliation and observability

| Block | What                              | Status | Date | Commit | Notes |
| ----- | --------------------------------- | ------ | ---- | ------ | ----- |
| 7.1   | Reconcilers I1–I9                 | ☐      |      |        |       |
| 7.2   | ~45 metrics (label rule enforced) | ☐      |      |        |       |
| 7.3   | 6 dashboards, Money Truth first   | ☐      |      |        |       |
| 7.4   | Alerts wired + runbook verified   | ☐      |      |        |       |
| 7.5   | Load generator                    | ☐      |      |        |       |

**Part 7 exit:** inject a fault → the right alert fires → the runbook resolves it.
**Record the demo video here.**

---

> ## 🏁 Minimum shippable project
>
> **Parts 0–7 complete = a finished, defensible project.** If you stop here you have a complete
> system with a demo, a test suite, and a story. Everything below is depth, not completeness.

---

## Parts 8–13 — Depth

Cut from the bottom if time runs short. See [`build-plan.md` §3.1](build-plan.md#31-cut-order).

| Block | What                                        | Status | Date | Commit | Notes |
| ----- | ------------------------------------------- | ------ | ---- | ------ | ----- |
| 8.1   | Refund aggregate + guards                   | ☐      |      |        |       |
| 8.2   | Chain-first ordering                        | ☐      |      |        |       |
| 8.3   | Partial refunds + triple overrun guard      | ☐      |      |        |       |
| 8.4   | Chargeback → debt entry + payout freeze     | ☐      |      |        |       |
| 9.1   | Payout aggregate                            | ☐      |      |        |       |
| 9.2   | Pre-payout screening gate                   | ☐      |      |        |       |
| 9.3   | Burn (the point of no return)               | ☐      |      |        |       |
| 9.4   | Fiat payout + float reservation             | ☐      |      |        |       |
| 10.1  | Three compliance ports                      | ☐      |      |        |       |
| 10.2  | Pinned OFAC snapshot loader                 | ☐      |      |        |       |
| 10.3  | Gates at pre_credit / pre_payout / periodic | ☐      |      |        |       |
| 10.4  | Velocity limits                             | ☐      |      |        |       |
| 11.1  | Reorg suite (within + beyond depth)         | ☐      |      |        |       |
| 11.2  | Full crash-injection matrix                 | ☐      |      |        |       |
| 11.3  | RPC disagreement cross-check                | ☐      |      |        |       |
| 12.1  | Stripe adapter behind the port              | ☐      |      |        |       |
| 12.2  | Shared port contract suite                  | ☐      |      |        |       |
| 13.1  | Payout batching                             | ☐      |      |        |       |
| 13.2  | Float rebalancing                           | ☐      |      |        |       |
| 13.3  | EIP-3009 gasless flow in the UI             | ☐      |      |        |       |

---

## Health check

Re-run before every commit. Update the date when you do.

| Check       | Command                    | Last green                    |
| ----------- | -------------------------- | ----------------------------- |
| Lint        | `pnpm lint`                | 2026-08-03                    |
| Typecheck   | `pnpm typecheck`           | 2026-08-03                    |
| Format      | `pnpm format:check`        | 2026-08-03                    |
| Contracts   | `pnpm contracts-test`      | — _(no tests yet, Part 2)_    |
| Unit        | `pnpm test`                | — _(no tests yet, Block 1.1)_ |
| Integration | `make test-integration`    | — _(no tests yet, Block 1.4)_ |
| Compose     | `docker compose config -q` | 2026-08-01                    |
| Alert rules | `promtool check rules`     | 2026-08-01 — 25 rules         |

---

## Log

Newest first. Record anything a future reader would need: decisions taken, things that surprised
you, blocks cut and why, questions you couldn't answer.

### 2026-08-01 — Phase 0 complete

Pivoted from an event-sourced staking indexer to a bidirectional fiat ⇄ stablecoin payment rail.
Repo was a docs-complete, code-empty scaffold, so switching cost was near zero.

**Two design corrections found while writing the docs:**

- **ADR-0010** — the inherited `raw_events` total unique key is a real bug for a payment system. A
  reorged transaction re-included at a different block gets silently `DO NOTHING`-ed, leaving a
  stale `block_number` that poisons confirmation-depth math. Fixed with a partial unique index.
- **ADR-0013** — minting per settlement would have made on-ramp float infinite, pushing the entire
  liquidity story onto the off-ramp, which is first on the cut list. Settlement now transfers from a
  finite treasury; minting became a separate treasury operation.

**Latent breakages fixed:** `nest build` emitted `dist/src/main.js` while the Dockerfile expected
`dist/main.js`; the CI lint job ran `pnpm typecheck` (which compiles Solidity) without Foundry
installed; the compose deployer exited successfully while producing nothing — now writes an
explicit `"placeholder": true` marker; all compose images pinned off `:latest`.

**Open question:** the on-disk directory is still `ChainStake/`. Cosmetic, rename whenever.

---

## How to update this file

At the end of each block:

1. Change ☐ → ✅ on the block's row
2. Fill in **Date** and **Commit** (short SHA)
3. Add a **Note** if anything was non-obvious — a surprise, a deviation, a thing you'd forget
4. Update the progress bar and the **Next action** at the top
5. Update **Health check** dates for anything you re-ran
6. Add a **Log** entry if the block changed a design decision

All of that goes in the **same commit as the block's code**. A tracker updated in a separate commit
drifts, and a drifted tracker is worse than none — it tells you things that aren't true.
