# Ledgerline — Project Rules

This file governs how work is done in this repository. It is intentionally short. Read it before
making changes.

## What this project is

A **bidirectional fiat ⇄ stablecoin payment rail**. Customers pay fiat; merchants are settled
non-custodially in a stablecoin we issue; merchants can cash out back to fiat.

Two append-only logs — `fiat_events` (off-chain) and `raw_events` (on-chain) — feed one double-entry
ledger. Every balance is a projection.

## Where facts live

Every fact in this project has **exactly one owning file**. Read the owner. Never restate a fact from
an owning file into a non-owning file — link to it instead. **If two files disagree, the owner wins,
and the disagreement is a bug to fix, not a reading to choose between** — say so before you continue.

| If you need…                                            | The owner is                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Golden rules, working rhythm, definition of done        | `CLAUDE.md` (this file)                                        |
| The coding contract (naming, TS, SQL, tests, commits)   | [`docs/conventions.md`](docs/conventions.md)                   |
| Chart of accounts, `kind` values, constraints, triggers | **the migrations** — `apps/indexer/src/migrations/`            |
| Metric names and the permitted label set                | [`docs/observability.md`](docs/observability.md) §1            |
| What is actually built                                  | [`docs/progress.md`](docs/progress.md)                         |
| Why a decision was made                                 | [`docs/decisions/`](docs/decisions/)                           |
| How the system is designed                              | [`docs/architecture.md`](docs/architecture.md)                 |
| The edge-case matrix                                    | [`docs/failure-modes.md`](docs/failure-modes.md)               |
| What to build next, in which file                       | [`docs/implementation-guide.md`](docs/implementation-guide.md) |
| Exit criteria, and what to cut first                    | [`docs/build-plan.md`](docs/build-plan.md)                     |
| Why a piece exists — the concepts                       | [`docs/learning-path.md`](docs/learning-path.md)               |

Row 3 is the load-bearing one: **for anything the database enforces, the migration is the truth and
every doc is a description of it.** Docs describing a constraint drift silently; a `CHECK` cannot.
`pnpm docs:check` enforces the rows it can check mechanically.

[`docs/ARCHITECTURE-WALKTHROUGH.md`](docs/ARCHITECTURE-WALKTHROUGH.md) **teaches** the design from
zero and owns nothing. It is the best entry point for a new reader and never the authority for a
value — where it restates a constant, that constant's owner above wins.

## Golden rules (do not violate)

1. **Two logs, one discipline.** `raw_events` and `fiat_events` are both append-only and both deduped
   by a provider-supplied identity (`UNIQUE(chain_id, tx_hash, log_index) WHERE NOT is_orphaned`;
   `UNIQUE(provider, provider_event_id)`). Never write state that cannot be re-derived from them.
   Projections — balances, saga status, `blacklist_status` — are disposable.
2. **Nothing is credited on a hint.** A receipt, a `200`, or an optimistic local write are hints.
   Sagas advance **only** on indexed, confirmed events. The one exception is a revert
   (`receipt.status = 0`), which drives a saga toward _compensation only_, never toward crediting.
3. **The ledger balances, and the database enforces it.** Immutable `ledger_entries`, a deferred
   constraint trigger asserting `Σ debits = Σ credits` **per asset** at COMMIT, and a non-negative
   check. Corrections are reversing transactions, never edits. `UPDATE`/`DELETE` are revoked on log
   tables.
4. **Money is an integer minor unit of a named asset.** `numeric(38,0)` / `string` in TS / `bigint`
   only inside helpers. **Never JS `number`.** Arithmetic may only combine the same `asset_code`.
   Cross-asset movement goes through the FX clearing pair, and rounding residuals are **journaled,
   never dropped**.
5. **Order compensations so the recoverable failure is last.** Refund: chain first, then fiat.
   Payout: burn first, then fiat. Everything reversible — screening, limits, float, simulation —
   happens strictly before the first irreversible step.
6. **Sign and persist before you broadcast.** Nonce under a row lock, signed `raw_tx` committed, then
   `eth_sendRawTransaction`. Re-broadcasting a mined tx is a success signal. Escalate only
   `MIN(nonce)` — never bump a later transaction to fill a hole.
7. **Fail loud at boot, isolate at runtime, park rather than fail.** Config/registry errors crash on
   startup. Per-event handler errors dead-letter and retry. Resource exhaustion (gas, float,
   screening unavailable) **parks** the saga in a named state instead of burning retries.
8. **Fail closed on compliance.** Never credit or pay out on an unavailable screening result. The
   cost of a wrong allow is unbounded; the cost of a delay is a support ticket.
9. **Never log secrets; never label with high-cardinality values.** The permitted Prometheus label
   set in `docs/observability.md` §1 is exhaustive. Never a merchant id, customer id, address, tx
   hash or payment id as a label — those belong in span attributes and structured logs.

## Working rhythm

> **make it work → `adversarial-tester` writes the tests → `ledger-reviewer` reviews the diff →
> make it observable → update `docs/progress.md` → commit.**

The two subagents are defined in `.claude/agents/`. They are not optional garnish: the agent that
wrote an implementation is the worst possible judge of it, because it tests the cases it was already
thinking about. Both run with no access to the implementer's reasoning — only the code on disk and
the project's own binding documents.

- Build **block by block** (Blocks `N.M` within Parts 0–13 — see
  [`docs/implementation-guide.md`](docs/implementation-guide.md) for the order,
  [`docs/build-plan.md`](docs/build-plan.md) for the exit criteria). One block per session. Each
  block ends in a working, committable state. Do not start a later block before the current one
  meets its exit criteria.
- A block is done when it has produced **all five** of: the code, its test, the `Verify` step's
  actual output, the `docs/progress.md` diff, and one conventional commit containing all four. If
  any of the five is missing, the block is `▶`, not `✅`.
- Every new path gets a metric and, where it tells a story, a custom span before it is done.
- **Every entry in `docs/failure-modes.md` names the test that proves it.** Adding a failure mode
  without its test is adding a claim, not a design.
- A significant decision gets an ADR in `docs/decisions/` recording the **alternatives considered and
  why each lost**. ADRs are immutable once merged; supersede, never edit.

## Conventions

> **Before writing or editing ANY code in this repo — every time, not just when asked to review —
> (re-)read the relevant section(s) of [`docs/conventions.md`](docs/conventions.md). It is binding.**
> Check the diff against it before calling the change done. An existing file already breaking a rule
> (e.g. an older migration's section-comment style) is not license to repeat that violation in new
> code — follow the written rule and flag the existing debt separately instead.
> Clean, readable, standard-following code is a hard requirement here, not a nicety. Clarity beats
> cleverness. The highlights below are the summary; the doc is the full contract.

- **Readability first:** intention-revealing names, small single-purpose functions, guard clauses
  over deep nesting, comment the _why_ not the _what_, no dead/commented-out code.
- **Package manager:** pnpm (workspaces). Node 22 (`.nvmrc`).
- **Commits:** Conventional Commits, enforced by commitlint. Scopes:
  `indexer | ledger | sagas | fiat | chain | compliance | mock-psp | web | contracts | shared |
infra | docs | ci | deps | repo`. Example: `feat(ledger): enforce per-asset balance at commit`.
- **TypeScript:** strict mode. No `any` without a written reason. No non-null `!`.
- **Solidity:** `forge fmt`; custom errors over `require` strings; Checks-Effects-Interactions;
  Foundry unit **and invariant** tests.
- **Statuses are `text` + `CHECK`, not Postgres enums.**
- **Config lives in git.** Grafana dashboards, Prometheus rules and alert routes are
  provisioned-as-code — never hand-clicked in a UI.

## Shapes that are always wrong here

Each of these shipped into this repo at least once and was caught in review, not by a test. They are
listed as _shapes_ because that is how you recognise them before you have finished writing the line.

- **`findOne` → `if (!found)` → `insert`.** A race, always, however unlikely concurrency feels for
  that path. Use `INSERT ... ON CONFLICT`.
- **An unlocked read that decides whether a write is legal.** A balance check, a limit check, a
  float check. Under `READ COMMITTED` two callers each read a state excluding the other's uncommitted
  rows and both pass. Take the row lock, or name what else serializes them.
- **A "residual", "remainder" or "dust" value whose unit is not a named asset's minor unit.** It
  cannot be journaled, so it will be dropped — and dropped dust is what makes a trial balance drift.
- **A guarantee enforced only in TypeScript.** Ask what stops a second code path, a migration, or a
  `psql` session at 3am. If the answer is "callers go through this function", it is a convention, not
  a constraint. Name the `CHECK`, foreign key or trigger that actually holds it.
- **A doc example that was never executed.** It is already wrong or shortly will be. Copy it into a
  test, or generate it from the code.
- **A comment describing behavior the function does not have.** Delete it or implement it — a stale
  comment actively misleads, which is worse than silence (`docs/conventions.md` §5).

## Honesty rules

This project models a regulated domain it is not licensed to operate in. Being precise about that is
part of the work, not a disclaimer bolted on at the end.

- **No theatre.** No "encrypted" key committed and called custody. No fake KYC vendor. No rules DSL
  with no data behind it. Build the parts that are real (signing policy, gate placement, the on-chain
  blacklist integration) and clearly label the parts that are simulated.
- **State the boundary of every claim** in the README, in the ADRs, and in code comments.

## Layout

```
apps/indexer        NestJS: ingest (both logs) · ledger · sagas · chain writer · compliance · API
apps/mock-psp       Fake payment provider with a fault-injection API
apps/web            Next.js demo UI
packages/contracts  Foundry: StableUSD + PaymentProcessor
packages/shared     ABIs, shared types, deployed addresses
infra               docker-compose + Prometheus/Grafana/OTel/Jaeger/Alertmanager + loadgen
docs                architecture · failure-modes · decisions/ · conventions · observability · runbook · build-plan
```

## Definition of done for a change

**Every line names how it is checked.** A checkbox you can tick from memory gets ticked; a checkbox
with a command next to it gets run. Run the command.

| ✔   | Done means                                             | Checked by                                                                                                                                      |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ☐   | Behavior implemented and covered by a test             | `pnpm test` and `pnpm test:integration` — both green, output pasted                                                                             |
| ☐   | The block's `Verify` step actually run                 | paste its **real output** into the commit body; "assumed" is not "verified"                                                                     |
| ☐   | Independent tests written for money-moving code        | `adversarial-tester` ran; never the agent that wrote the implementation                                                                         |
| ☐   | Independent review of the final diff                   | `ledger-reviewer` ran; every finding resolved or recorded — **required** for `ledger/`, `sagas/`, `chain-writer/`, `compliance/`, `migrations/` |
| ☐   | New failure modes documented **with their test**       | `rg "<the new rejection path>" docs/failure-modes.md` finds it                                                                                  |
| ☐   | Metrics/spans on any new path, labels permitted        | `rg 'metrics\.' <changed files>` is non-empty, or the commit body says why not                                                                  |
| ☐   | Money is integer minor units, one asset per expression | `rg ': number' <changed files>` has no money-typed hit                                                                                          |
| ☐   | Significant design choice has an ADR                   | a new file in `docs/decisions/` with alternatives and why each lost                                                                             |
| ☐   | Docs and schema still agree                            | `pnpm docs:check`                                                                                                                               |
| ☐   | Lint, types, formatting clean                          | `pnpm lint && pnpm typecheck && pnpm format:check`                                                                                              |
| ☐   | `docs/progress.md` updated **in this same commit**     | `git diff --cached --name-only \| rg docs/progress.md`                                                                                          |
| ☐   | Conventional commit message                            | commitlint (husky `commit-msg`)                                                                                                                 |

On the tracker: flip the block to ✅, fill in date and commit, update the progress bar and "Next
action", add a Log entry if a design decision changed. **Only add information** — never overwrite an
earlier completion date in place; record an extension in the Notes column or the Log instead. A
tracker updated in a later commit drifts, and a drifted tracker is worse than none because it states
things that aren't true.
