# Ledgerline — Progress Tracker

> **Update this file at the end of every block, in the same commit as the work.**
> A tracker updated later is a tracker nobody trusts.

**Overall: 16 / 76 blocks complete** — Phase 0 done, Part 1 in progress.

```
Phase 0  ████████████████████  9/9    ✅ complete
Part 1   ███████████████░░░░░  7/9    ← YOU ARE HERE
Part 2   ░░░░░░░░░░░░░░░░░░░░  0/8
Part 3   ░░░░░░░░░░░░░░░░░░░░  0/8
Part 4   ░░░░░░░░░░░░░░░░░░░░  0/5
Part 5   ░░░░░░░░░░░░░░░░░░░░  0/6
Part 6   ░░░░░░░░░░░░░░░░░░░░  0/6
Part 7   ░░░░░░░░░░░░░░░░░░░░  0/5
Parts 8–13                     0/20   (optional — see cut list)
```

**Next action:** Block 1.7 — Balances projection. The account row lock already exists
(`1754006400007`); 1.7 moves the non-negative check onto the locked projection row, which is what
removes its full-history rescan per insert.

**Minimum shippable point:** end of **Part 7**. Every thing after that is depth.

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

| Block | What                                              | Status | Date       | Commit  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | ------------------------------------------------- | ------ | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0   | App boots, connects to Postgres                   | ✅     | 2026-08-03 | 2a42ce9 | zod env fails loud at boot; `/health` does a real `SELECT 1`; `incremental:false` fixed a silent stale `dist/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1.1   | `money.ts` — integer money, `splitFee`, `convert` | ✅     | 2026-08-04 |         | integer minor unit math, fee derivation, fast-check property tests passing (1000/1000 runs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1.2   | Double-entry concept _(no code)_                  | ✅     | 2026-08-05 |         | Debits = Credits mental model, 4 account types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1.3   | Ledger tables + entities                          | ✅     | 2026-08-05 |         | CreateLedgerTables migration + 5 TypeORM entities registered in LedgerModule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 1.4   | Deferred balance trigger                          | ✅     | 2026-08-30 |         | `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`; integration test proves COMMIT throws on an unbalanced USD leg. Extended 2026-08-30 (see Log) to also enforce non-negative per `allows_negative`, closing a gap against `docs/architecture.md`/ADR-0004                                                                                                                                                                                                                                                                                                                   |
| 1.5   | Immutability trigger + `reverses_id`              | ✅     | 2026-08-30 |         | `BEFORE UPDATE OR DELETE` trigger on both log tables; least-privilege `ledgerline_app` role split out (owner bypasses REVOKE, so a second role was required for it to mean anything); transaction-level `reverses_id` added                                                                                                                                                                                                                                                                                                                                                       |
| 1.6   | `LedgerService.post()` — the single writer        | ✅     | 2026-08-30 |         | `AccountRegistryService` resolves codes → UUIDs, creates per-merchant accounts on demand; `post()` validates in TS then commits via `ON CONFLICT DO NOTHING`; idempotency and unbalanced-rejection proven by integration test. Extended 2026-09-06/07 by the audit (see Log): entries insert in `account_id` order so postings cannot deadlock against each other, `post()` accepts a caller's `QueryRunner` and refuses one with no open transaction, account resolution runs on that same connection, `postedAt` is threaded for replay, and the first ledger metric is emitted |
| 1.7   | Balances projection + row lock                    | ☐      |            |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1.8   | Trial-balance property test                       | ☐      |            |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Part 1 exit:** see [`build-plan.md`](build-plan.md), which owns the exit criteria — restating them
here is how this row and the build plan came to disagree about the third one.

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

| Check          | Command                    | Last green                                     |
| -------------- | -------------------------- | ---------------------------------------------- |
| Lint           | `pnpm lint`                | 2026-09-24 — eslint + `docs:check`             |
| Docs vs schema | `pnpm docs:check`          | 2026-09-24 — 6 checks, 3 of them doc↔schema    |
| Typecheck      | `pnpm typecheck`           | 2026-09-19                                     |
| Format         | `pnpm format:check`        | 2026-09-24                                     |
| Contracts      | `pnpm contracts:test`      | — _(no tests yet, Part 2)_                     |
| Unit           | `pnpm test`                | 2026-09-24 — 97 indexer unit + 45 script       |
| Integration    | `pnpm test:integration`    | 2026-09-24 — 140 tests, throwaway DB, in CI    |
| Compose        | `docker compose config -q` | 2026-08-01 — _(Docker not running 2026-09-06)_ |
| Alert rules    | `promtool check rules`     | 2026-08-01 — 25 rules                          |

---

## Log

Newest first. Record anything a future reader would need: decisions taken, things that surprised
you, blocks cut and why, questions you couldn't answer.

### 2026-09-24 — Three ledger fixes ahead of Block 1.7 (ADR-0019)

A review of the ledger before starting 1.7 found three gaps, fixed on `claude/loving-rubin-p5t173`.
No block changes status: this is hardening of Blocks 1.4–1.6, recorded here rather than by editing
their rows.

- **The trigger locked and scanned accounts whose check can never fail.** Migration `1754006400009`
  puts `AND NOT allows_negative` into the locking read, so `1800`/`1810`/`3900` are never locked or
  scanned. Measured on a scratch database with 50k prior entries per account, 50 concurrent postings
  to `1800`/`3900`: wall 1.86–2.10 s before, 0.26–0.29 s after (three runs each).
- **The trigger's two rejections shared SQLSTATE `P0001`.** They now raise `LL001`/`LL002`, and
  `ledger-errors.ts` maps them to typed errors a saga can route on — park vs dead-letter — without
  matching message text. New counter `ledgerline_ledger_postings_rejected_total{kind, reason_class}`.
- **A replay with different legs was acknowledged silently** (walkthrough §14 item 8). `post()` now
  compares the replay's legs with the stored entries and throws `LedgerIdempotencyConflictError`.

`adversarial-tester` wrote the tests for every changed file (five new files, failure modes C12/C13)
and found no defects. `ledger-reviewer` then reviewed the whole branch diff: no critical or major findings; its two nitpicks — a stale Block 1.4 snippet in `implementation-guide.md` and no direct unit test for the new metric method — were both addressed on this branch. The full-history scan on accounts _with_ a
floor remains Block 1.7's to remove.

### 2026-09-20 — The indexer image had not built since pnpm 10

The first CI run after the audit failed only at `docker-build`: pnpm 10's `deploy` refuses a package
with workspace dependencies unless the whole repo sets `inject-workspace-packages=true`. The
Dockerfile predates the pin to pnpm 10 and CI had not run since, so it went unnoticed. Fixed with
`--legacy` on the one `deploy` line rather than changing how every workspace links
`@ledgerline/shared` in development — the indexer only imports types from it. Verified by running
the image: it fails loud on missing config, runs as `node`, carries no dev tooling, and against the
dev database serves `/health` → `{"status":"ok","db":"up"}`. A `TODO(Block 2.7)` marks the next trap:
`shared`'s `main` is TypeScript, so its first runtime import will break the image.

### 2026-09-20 — CI runs only what is built

`ci.yml` now runs only jobs for completed work. The `contracts` job is commented out until Block 2.1
— Part 2 has no completed block. The `unit` job ran the root `pnpm test`, which fans out to every
workspace, including the contracts' `forge test` (Part 2, and that job never installs Foundry, so it
would fail on GitHub while passing locally) and mock-psp's tests (Part 5). It now runs the indexer's
tests and the script tests only, with the full fan-out left commented under `TODO(Block 5.1)`.
`lint`, `integration` and `docker-build` stay: they cover Phase 0 and Part 1.

### 2026-09-20 — `convert()`'s rounding direction, written down and pinned

Asked what happens at a rate like 3/2: the floor on delivery and the ceiling on consumption are one
sub-unit gap seen from each side, and the platform keeps it. Compared against the standards —
half-even (unbiased, accounting systems), half-up (EU euro conversion), and the directional
"round in the protocol's favour" rule of Uniswap V3 and ERC-4626 — the directional rule stays: an
issuer must never deliver more than it holds backing for, on every conversion, not on average.
ADR-0015 now records the direction, the bound (under one target minor unit per conversion) and that
the gap is not journaled; `adversarial-tester` pinned the target side with property tests (no
counterexample in 2,000 runs per property). The revaluation posting that would move accumulated gaps
into a named account is deferred to the first non-1:1 rate — walkthrough §14 item 13.

### 2026-09-19 — The documented on-ramp did not post; all three flows corrected

Working through every review checkpoint in `ARCHITECTURE-WALKTHROUGH.md` against the code, the §7
checkpoint — "balanced does not mean correct" — was taken literally and the worked $100 on-ramp was
run against the migrated schema. **T5 was rejected at COMMIT**: it debits `2000 merchant_payable`,
which no earlier posting credited. T3 also credited `2500 stablecoin_issued` per payment, contrary to
ADR-0013, and the refund and payout postings inherited the model (the audit's deferred payout item
was a symptom of this). [ADR-0018](decisions/0018-ledger-flow-postings.md) redesigns all three: the
merchant is owed from T3, T4 draws float from `1100`, minting is its own `treasury.mint` posting,
the platform keeps its fee on refunds (shortfall → `1300` merchant debt), and the fee is taken
off-chain only. Five kinds appended (migration `1754006400008`); every posting is executed by
`ledger-flows.integration-spec.ts`, which `adversarial-tester` wrote from the ADR and the code, not
the author of the design. An operator mint command joins Block 6.4 — without it the
on-ramp has no float to settle from — and the automatic rebalance stays in the cut-first Phase 13.

A full sweep of every doc against the code found ~60 more stale statements, now fixed; `docs:check`
widened to prose SQL-style kind literals (how `runbook.md` named a rejected kind) and to TODO markers in
config files (thirteen `TODO(Phase N)` had survived there). `adversarial-tester` found two defects
in that widening — a crash when the root `Makefile` is absent, and double-quoted literals missed —
both fixed. It also proved the ledger does **not** bind a refund to its payment; ADR-0018 records
that boundary. Two open questions for Block 4.4 are in the walkthrough's §14.

`ledger-reviewer` then caught what a green run hid: that boundary test **committed** a ~1M USDX
phantom reclaim into the shared `1100`, and an older test assumed `1100` held under 10k USDX — so the
suite failed 1 run in 3 depending on file order. The phantom test now proves its point inside a
rolled-back transaction (`SET CONSTRAINTS ALL IMMEDIATE` runs the deferred trigger), and the older
test reads the live balance instead of hard-coding an overdraw. The flows spec was then rewritten so
it commits nothing at all — every scenario runs in a rolled-back transaction and funds its own float,
and a final test proves zero rows remain; the rewrite exposed scenarios that had only passed on float
earlier tests left behind. A final independent sweep found 27 more disagreements, now resolved; three
need a decision and are open items 11–12 in the walkthrough's §14 and the audit addendum. It also
found that failure mode C7's database layer had no test; `ledger-constraints` now proves the
trigger rejects cross-asset "balanced" sets. Full gate green three consecutive runs.

### 2026-09-07 — The audit's own fixes, audited

The 2026-09-06 entry below describes an audit that found four bugs. Handing the rest of the changed
files to `adversarial-tester` — which should have happened for all fourteen, not two — found four
more, **three of them in that audit's own fixes**: `post()` was not atomic when handed a
`QueryRunner` with no open transaction, and `docs:check` had two ways to report "no divergences"
while checking nothing. `ledger-reviewer` separately found three stale `FOR UPDATE` comments the
audit itself had introduced.

**The measurement that changed a design decision.** ADR-0017 called the residual cross-account
deadlock rare. Measured, it was 87.5% — 35 of 40 crossed postings. So the deterministic lock ordering
the ADR had deferred to Block 1.7 is no longer deferred: `post()` inserts entries ordered by
`account_id`. Verified independently at 0 of 40 through `post()`, against 33 of 40 for the same shape
driven by raw SQL.

**`scripts/docs-check.mjs` held five vacuous passes** — more defects per line than anything else
touched, in the file whose whole purpose is catching defects. Four were invisible to reading and to a
green run; each surfaced only by mutating an input and confirming the check went red. Its own suite is
now 27 tests, every one constructing an input that should fail.

**Two process rules changed as a result.** The definition of done now makes the unit of independent
testing the **changed file**, not the session — "I invoked `adversarial-tester`" is satisfiable by
invoking it once, which is exactly what happened. And `docs:check` gained a sixth assertion, because
the walkthrough drifted twice and nothing mechanical caught either.

**A doc-ownership bug found while sweeping.** `build-plan.md` and this tracker disagreed about Part
1's exit criteria, and the version quoted throughout the audit was this file's — the non-owner.
`build-plan.md` owns exit criteria, now carries both, and this file links rather than restating.

### 2026-09-06 — Full-repository audit, and the fixes

Reviewed every document, all source, six migrations, the tests, CI and the infra scaffolding against
this project's own rules. Full record, including what was deliberately **not** fixed and why, in
[`reviews/2026-09-06-audit-and-fixes.md`](reviews/2026-09-06-audit-and-fixes.md).

**The root cause of the process failures was structural.** Four files stated the rules and three were
lossy paraphrases, so an agent could read one, miss a rule living only in another, and believe it had
complied. Facts had the same problem: the chart of accounts and the `kind` list each lived in a
migration _and_ three prose docs, and had drifted far enough that the implementation guide's own code
sample raised a `CHECK` violation. `CLAUDE.md` now names one owning file per fact, the other rule
files are pointers with no content of their own, and `pnpm docs:check` fails the build on divergence.

**Four correctness bugs, two of them money bugs.** `convert()` returned a residual whose unit changed
with the scale direction — unpostable when upscaling, so ADR-0001's "journal the dust, never drop it"
could not actually be carried out (ADR-0015). The non-negative check read balances without a lock, so
two concurrent commits could each pass and drive an account negative — exactly Part 1's exit
criterion, which could have yielded 11 of 20 (ADR-0017). An entry's asset was not bound to its
account's asset. `createMerchantAccount` was a check-then-insert race.

**Two things worth remembering.** Both existing `convert()` assertions passed against the wrong
function, because at a 1:1 rate the wrong unit coincidentally equals the right one — a passing test
proved nothing because it never varied the parameter that mattered. And the lock fix was wrong twice before it was
right: `FOR UPDATE` first failed with `permission denied` (`ledgerline_app` has no `UPDATE` grant on
`ledger_accounts` by design, so the trigger had to become `SECURITY DEFINER`), and then deadlocked
49 of 50 concurrent postings, because the composite foreign key added in the same migration takes a
`KEY SHARE` lock that `FOR UPDATE` conflicts with. `FOR NO KEY UPDATE` is the correct mode. None of
that was findable by reading — only by running it.

**Blocks 1.4, 1.5 and 1.6 keep their original completion dates above.** They were done as specified;
the specification and its enforcement were what needed work. The fixes are separate commits.

**Definition-of-done gaps closed:** metrics are possible at all now (`ObservabilityModule` was in
`app.module.ts`'s _comment_ but never its imports), integration tests run in CI against a throwaway
database, and `adversarial-tester` / `ledger-reviewer` are in the working rhythm rather than only in
their own definitions. `adversarial-tester` earned it immediately — it found a ceiling-division bug in
the `convert()` fix itself.

### 2026-08-30 — Block 1.4, a doc-alignment correction found while explaining Block 1.6

`docs/architecture.md` §2.2 and ADR-0004 both describe the balance trigger as enforcing THREE
things: immutability, balance, and non-negative (`allows_negative = false` accounts must never go
below zero). `implementation-guide.md`'s Block 1.4 section only asked for the first two — the
non-negative check was actually assigned to Block 1.8's property test, phrased as an `assert` rather
than a DB-enforced rule. The gap surfaced answering a conceptual question about what `allows_negative`
means; asked to strictly follow the design docs, closed it with a new migration
(`1754006400004-LedgerNonNegativeCheck.ts`, `CREATE OR REPLACE FUNCTION` on the same trigger — the
original 1.4 migration was left untouched, same "supersede, never edit" discipline as ADRs) that
derives each touched account's running balance directly from `ledger_entries` (no
`ledger_account_balances` yet) signed by its own `normal_side`, and rejects the commit if a
non-`allows_negative` account would end up below zero. Proven by two new tests: one drives a fresh
`allows_negative=false` test account negative and expects rejection, the other does the same to
`fx_clearing` (`allows_negative=true`) and expects success.

Building Block 1.6's `AccountRegistryService` surfaced a second, unrelated grant gap: the
`ledgerline_app` role could `SELECT` but not `INSERT` into `ledger_accounts`, so creating a
per-merchant account at runtime failed with `permission denied`. Closed with
`1754006400005-GrantAppRoleAccountInsert.ts` — `INSERT` only, no `UPDATE`/`DELETE`.

### 2026-08-30 — Block 1.5, a scope correction

The implementation guide's `REVOKE UPDATE, DELETE ... FROM <app_role>` assumed an app role distinct
from the table owner. The repo only had one Postgres role (`ledgerline`), used for both migrations
and the running app. A table owner always bypasses `GRANT`/`REVOKE` in Postgres, so that `REVOKE`
against the owner would have been a no-op — enforcing nothing while looking like it did.

Fixed by introducing a second role, `ledgerline_app`, created and granted least-privilege access in
the migration itself, with `APP_DATABASE_URL` added so the running app (`AppModule`) connects as it
while `DATABASE_URL`/the migration CLI stay on the owning role. The `BEFORE UPDATE OR DELETE` trigger
remains the real enforcement (it fires for owners too); the REVOKE is now a genuine second layer,
proven by a test that connects as `ledgerline_app` and gets `permission denied`, not the trigger's
exception.

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

**Open question:** ~~the on-disk directory is still `ChainStake/`~~ — resolved 2026-09-06; it is `Ledgerline/`.

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
