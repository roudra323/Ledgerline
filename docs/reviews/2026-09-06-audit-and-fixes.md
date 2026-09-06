# Audit and fixes — 2026-09-06

A full review of the repository (every document, all source, six migrations, the tests, CI and the
infra scaffolding) against its own binding rules, and what was changed as a result.

**Baseline:** `3915c45`, plus Block 1.6's work which was complete in the working tree but uncommitted.

---

## Why the process half of this happened

Four files stated the project's rules — `CLAUDE.md`, `AGENTS.md`, `.agents/rules/conventions.md` and
`docs/conventions.md` — and three were lossy paraphrases of the others. An agent could read one, miss
a rule that lived only in another, and be confident it had complied. `.agents/rules/conventions.md`
said "never log high-cardinality labels" without mentioning that `observability.md` §1 defines an
**exhaustive permitted set**, so an agent reading only that file would invent a label and believe it
was following the rules.

The same disease affected facts, not just rules. The chart of accounts and the transaction `kind`
list each appeared in a migration **and** in three prose documents, and the copies had already
diverged badly enough that the implementation guide's own code sample could not execute.

Every fix below is downstream of that. The first change was to give every fact one owner and make a
script enforce it; without that, this list regenerates itself in three months.

---

## 1. Correctness

### 1.1 `convert()` returned an unpostable residual — `money.ts`

ADR-0001 requires the FX residual to be journaled to `3900 rounding_residual`, never dropped, but
never said what **unit** it is in. The implementation returned the raw remainder of its internal
division, whose unit silently changed with the direction of the scale change: source minor units when
downscaling, but a fraction of a **target** minor unit divided by `rateDen` when upscaling.

Converting 10000 USD cents to USDX at 1/3 returned `residual = 1`, meaning one third of one USDX minor
unit — a quantity of no asset, which `numeric(38,0)` cannot hold and no account can. At a 1:1 rate the
downscale case coincidentally equals source minor units, which is why both existing assertions passed
against a wrong function for the life of Block 1.1.

**Fixed.** `residual` is now the part of `amountMinor` too small to buy another whole target minor
unit, in the source asset. Both pre-existing assertions still pass unchanged. See
[ADR-0015](../decisions/0015-rounding-residual-unit.md).

**A second bug inside the fix, caught by `adversarial-tester`.** The first version computed `consumed`
with floor division, which double-floors: `convert("1", 0, 1, "1", "3")` reported buying 3 target
units **and** leaving the whole source unit as residual — it would have double-booked the same unit,
the mirror image of the original bug. Now ceiling division.

**Also fixed here.** `BigInt("")` and `BigInt("   ")` are both `0n`, so a webhook with a blank amount
posted a legitimate-looking zero-value leg instead of failing loudly. Amount strings are now validated
as plain integers. And `fromDecimals`/`toDecimals` are bounded to `0..18` mirroring the `assets`
table's `CHECK` — `10n ** BigInt(huge)` hung rather than threw.

### 1.2 The non-negative check was not concurrency-safe — `1754006400004`

The check derived an account's balance with a bare `SUM` over `ledger_entries`. The trigger is
deferred so it runs at COMMIT, but under `READ COMMITTED` it still sees committed rows only: two
transactions reaching their commit-time trigger together each read a balance excluding the other's
entries, both pass, and an `allows_negative = false` account goes negative.

Textbook write-skew, and precisely Part 1's exit criterion — _20 concurrent payouts against float for
10 → exactly 10_ — which could have yielded 11.

**Fixed** in `1754006400007` by locking the account row the trigger already reads (`FOR NO KEY UPDATE` — the mode matters, see below), so
concurrent commits touching one account queue. See
[ADR-0017](../decisions/0017-non-negative-enforcement.md), including why a deadlock here is the
correct failure.

**Two consequences only running things revealed**, neither findable by reading:

_Privileges._ `SELECT ... FOR UPDATE` requires `UPDATE` privilege, and `ledgerline_app` deliberately
has only `SELECT` and `INSERT` on `ledger_accounts`. Every posting failed at COMMIT with
`permission denied`. The function is now `SECURITY DEFINER` with a pinned `search_path` — a privilege
boundary that must stay tiny and auditable.

_Lock mode._ The first version used `FOR UPDATE`, which **deadlocks by construction** against the
composite foreign key added in §1.3: the FK makes every `ledger_entries` INSERT take a `KEY SHARE`
lock on its account row until commit, and `FOR UPDATE` conflicts with `KEY SHARE`, so every concurrent
posting holds a lock all the others need. Neither change is wrong alone; together the wrong lock mode
is catastrophic. `FOR NO KEY UPDATE` is exclusive against itself — all the serialisation this check
needs — and compatible with `KEY SHARE`. Measured on PostgreSQL 17, 50 concurrent postings released
through a simultaneous COMMIT barrier against float for 10:

| Lock mode                     | Elapsed   | Succeeded | Final balance     |
| ----------------------------- | --------- | --------- | ----------------- |
| none (the bug)                | 14 ms     | **13**    | **−3 — negative** |
| `FOR UPDATE`                  | 54,834 ms | **1**     | 9 — 49 deadlocks  |
| `FOR NO KEY UPDATE` (adopted) | 14 ms     | **10**    | 0                 |

The first row is the original write-skew, reproduced. It takes a commit barrier and more than ~20
concurrent writers to surface on one machine, which is why an ordinary 20-way concurrency test passes
with **and without** the lock — and why this would have reached production as an occasional,
unexplainable negative balance rather than a failing test. The committed regression test uses the
barrier for that reason.

### 1.3 An entry's asset was not tied to its account's asset

Nothing in the schema stopped a `USD` entry pointing at a `USDX` account. The application path was safe
only by accident, and `resolveMerchantAccount` would happily **create** a `2000 merchant_payable` in
`USD` even though the chart of accounts says `2000` is USDX. Any second writer — a migration, a `psql`
session, Part 4's reorg reversal — had no guard at all, and an ungrouped `SUM(amount_minor)` across a
mismatched entry produces a plausible-looking, wrong number.

**Fixed.** Composite foreign key `ledger_entries (account_id, asset_code) → ledger_accounts (id,
asset_code)`, and each merchant account code now pins its asset so a wrong-asset resolve is rejected
rather than silently creating an account. New failure mode **C10**.

### 1.4 `createMerchantAccount` had a check-then-insert race

`findOne` → miss → `save`. Two first-time payments for one merchant both missed, and the loser got a
raw unique violation that failed a legitimate payment.

**Fixed.** `INSERT ... ON CONFLICT DO NOTHING` plus a re-select. New failure mode **C11**.

### 1.5 `posted_at` was documented as set by `post()` and never was

The entity docstring claimed replays could back-date postings. They could not, so a replay would have
stamped rebuilt history with the replay's clock and silently broken Part 4's replay-determinism
deep-equal. **Fixed** — `postedAt` is threaded through `PostingRequest`.

---

## 2. Docs that contradicted the schema

| Divergence                                                                                                                                                                                                                                                            | Resolution                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture.md`, `implementation-guide.md` and `learning-path.md` all post `onramp.capture`/`.fx`/`.reserve`/`.settled`; the `CHECK` accepted eight snake_case values and had no `fx` or `reserve` kind, so the documented four-posting on-ramp was not expressible | Schema moved to the dotted vocabulary ([ADR-0016](../decisions/0016-transaction-kind-vocabulary.md)) — the docs were right and are the teaching material. `kind` is half the idempotency key, so **the set is append-only from here** |
| Block 1.6's `Verify` step said "read the balances back"; `post()` does not write balances                                                                                                                                                                             | That half moved to Block 1.7, where the projection is built                                                                                                                                                                           |
| Failure mode **C1** specified `residual < 1` minor unit of the **target** asset — the exact unit ADR-0015 removed — and claimed upscaling is always exact                                                                                                             | Rewritten for the source-asset residual; exactness only holds when the rate divides evenly                                                                                                                                            |
| Failure mode **C4** described the check as running "against the row-locked balances projection", which does not exist yet                                                                                                                                             | Rewritten to describe what actually enforces it today, and what Block 1.7 changes                                                                                                                                                     |
| `TODO(Phase N)` markers in 41 files; the numbers were wrong, not merely mislabelled — observability said Phase 3/4 for Part 7 work, everything under `blockchain/` said Phase 1/2 for Part 4 work                                                                     | All retargeted to `Block N.M` or `Part N`; `docs:check` now rejects `TODO(Phase …)`                                                                                                                                                   |
| `progress.md`'s health check told you to run `pnpm contracts-test` and `pnpm test:integration`; neither existed at the root                                                                                                                                           | Script fixed, root `test:integration` added, and `docs:check` now verifies every command in that table                                                                                                                                |
| `base-audit.entity.ts` claimed four tables are equally immutable; only two have the trigger                                                                                                                                                                           | Docstring now says which layer protects which                                                                                                                                                                                         |

---

## 3. Definition-of-done gaps on blocks already ✅

- **No metrics existed anywhere.** `ObservabilityModule` was named in `app.module.ts`'s comment but
  absent from its `imports`, and `metrics.service.ts` was an `export {}` stub. There was no `/metrics`
  endpoint, so "every new path gets a metric" was **unenforceable**, not merely unenforced — which is
  why the most-called function in the project shipped emitting nothing. Wired, with the one instrument
  `observability.md` §1.3 already specifies.
- **Integration tests were not in CI.** The job was an `echo`. Every ledger guarantee proven so far
  ran on one laptop. Now a `postgres:17-alpine` service and a real run.
- **Integration tests were not isolated.** They write into deliberately immutable tables and cannot
  clean up, so every run accumulated rows — compounding, since the non-negative trigger scans an
  account's whole history. Now a throwaway database per run, which also proves the migrations apply
  from nothing every time.
- **The two subagents were never invoked.** `.claude/agents/ledger-reviewer.md` and
  `adversarial-tester.md` both say "MUST be invoked", but only those files said so and nothing reads
  them until someone invokes the agent. Now in the working rhythm and the definition of done. Both
  earned it immediately: `adversarial-tester` found the ceiling-division bug in §1.1, and
  `ledger-reviewer` found two stale lock-mode comments this branch itself introduced — the exact
  shape `CLAUDE.md`'s new "shapes that are always wrong here" section warns about.

---

## 3a. A second testing pass, and what it says about the first

The first pass satisfied the definition-of-done line "`adversarial-tester` ran" while failing what
that line was for. Of **fourteen files with non-comment changes**, two went to the agent, the author
wrote tests for two more himself, and three had none at all. Handing over the remainder found four
further defects — **three of them in this audit's own fixes**:

| Defect                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `post()`'s atomicity was conditional. Given a `QueryRunner` that was `connect()`-ed but never `startTransaction()`-ed, every statement autocommitted: the header committed, the first leg was then a one-legged unbalanced transaction and was rejected, leaving an orphaned `ledger_transactions` row with zero entries — which the immutability trigger makes permanent. Now refuses a runner with no active transaction | `ledger.service.ts`                               |
| `docs-check.mjs` scanned only double-quoted `kind: "..."`, so a single-quoted sample posting an invalid kind passed silently — a vacuous pass in the check whose whole job is catching that. Widening the quote class alone makes every TypeScript union example in the docs a false positive, so the discriminator is now whether the fenced block is actually a posting                                                  | `scripts/docs-check.mjs`                          |
| `docs-check.mjs` chose "the" kind-defining migration with a bare `/kind IN (/`, so any later migration adding an unrelated `CHECK` on another table's `kind` column would hijack the check and fail against the correct migration. Now anchored on `ledger_transactions`                                                                                                                                                   | `scripts/docs-check.mjs`                          |
| ADR-0017 called the residual cross-account deadlock "rare". Measured: **87.5%** — 35 of 40 crossed postings released together. Correctness held (every abort a clean rollback, balances summing to zero) but availability collapsed                                                                                                                                                                                        | `docs/decisions/0017-non-negative-enforcement.md` |

The last one is no longer deferred. `post()` now inserts a transaction's entries **ordered by
`account_id`**, giving every posting through the single writer one global lock order — the textbook
remedy for lock-order deadlocks. `sequence` is an explicit column, so what it records is unchanged.
Direct SQL writers keep the residual risk and get an abort rather than a wrong balance.

Three of the agent's tests _documented_ defects rather than asserting fixed behaviour, in the same
style as its earlier `BigInt("   ")` finding. Each was flipped to assert the fix, keeping the
original defect in the comment so the test explains why it exists.

**The rule this changed.** `CLAUDE.md`'s definition of done now makes the unit of independent
testing the **changed file**, not the session: "I invoked `adversarial-tester`" is not the standard,
"every file I changed was tested by someone who did not change it" is.

## 4. Instructions

- `CLAUDE.md` gained **Where facts live** — one owning file per fact; non-owners link rather than
  restate; when two disagree the owner wins and the disagreement is a bug, not a choice.
- `AGENTS.md` and `.agents/rules/conventions.md` are now pointers with no rules of their own.
- Every definition-of-done line names the command that checks it.
- `CLAUDE.md` gained **Shapes that are always wrong here**, each drawn from a defect in this audit.
- `pnpm docs:check` (in `pnpm lint`) enforces five doc↔schema agreements mechanically.

---

## 5. Deliberately not fixed

| Item                                                                                                                                                                                     | Why, and when                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The non-negative check still re-derives from the account's full history on every insert — `O(entries)` per row, forever                                                                  | The fix is to read the locked `ledger_account_balances` row, which is **Block 1.7's** entire purpose. Merging a feature block into a fix pass would break the one-block-per-session rule and make this record unreadable. `TODO(Block 1.7)` marks the spot                                                            |
| The balance trigger is `FOR EACH ROW`, so an N-leg posting aggregates N times at COMMIT                                                                                                  | Same fix, same block                                                                                                                                                                                                                                                                                                  |
| `alreadyPosted` does not verify the new legs match the stored ones                                                                                                                       | The right shape for a request fingerprint depends on **Block 6.2's** idempotency-key work, which already stores a `request_hash` for exactly this. Resolve it there, not later                                                                                                                                        |
| Only one of ~45 metrics is registered                                                                                                                                                    | The rest land with the paths that emit them (**Part 7** for the aggregate reconciler gauges). The point of wiring the module now is that the checklist item is satisfiable, not that the dashboard is complete                                                                                                        |
| `forge install` in CI is unpinned                                                                                                                                                        | **Block 2.0** is where the versions are actually chosen. Pinning to a guessed tag today would be worse than the honest `TODO(Block 2.0)`                                                                                                                                                                              |
| `fx_clearing` is numbered `1800`/`1810`, inside the `1xxx` asset range, while typed `equity`                                                                                             | Renumbering seeded accounts that an in-progress ledger already references buys consistency at the cost of a data migration. Documented rather than moved; revisit only if the chart is reseeded                                                                                                                       |
| `ledger_transactions.cause_type` is free `text` with no `CHECK`, while `kind` — the other half of the same idempotency key — is a bounded union both the schema and `docs:check` enforce | A typo (`fiat_event` vs `fiatEvent`) would silently defeat the UNIQUE and credit twice. Deferred only because **Block 5.2** is where the set of cause types the two logs emit is actually decided; a `TODO(Block 5.2)` sits on the type. Must land before any saga becomes a real caller                              |
| `LedgerService.post()` cannot construct a reversal                                                                                                                                       | Golden rule 3 promises corrections are reversing transactions and `reverses_id` exists for them, but `PostingRequest` has no field and the INSERT never sets it — a documented capability with no implementation. **Block 4.4** (reorg reversals) is the first caller that needs it; `TODO(Block 4.4)` marks the spot |
| The throwaway test database leaks if a run is hard-killed between setup and teardown                                                                                                     | `globalTeardown` covers every ordinary exit, verified. A periodic `DROP DATABASE` sweep of `ledgerline_test_%` is the belt-and-braces fix; not worth the machinery until CI actually leaks one                                                                                                                        |
| The payout state machine in `build-plan.md` credits `token_in_transit` twice with no debit                                                                                               | As written the non-negative trigger would now reject it — reliably, after the lock fix. Almost certainly state-diagram shorthand rather than real postings, but it must be resolved **before Part 9**                                                                                                                 |

---

## 6. Verification actually run

| Gate                                                                    | Result                                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` (eslint + `docs:check`)                                     | clean                                                                                                                                           |
| `pnpm typecheck`                                                        | clean                                                                                                                                           |
| `pnpm test`                                                             | 53 passed                                                                                                                                       |
| `pnpm test:integration` against a freshly created and migrated database | 22 passed in 0.9 s (local `postgresql@17`)                                                                                                      |
| Migration round-trip: 8 up → 3 revert → 3 up                            | all 12 kinds, both new constraints, `SECURITY DEFINER` + pinned `search_path` + `FOR NO KEY UPDATE` + the asset filter present afterwards       |
| CI workflow YAML                                                        | parsed and validated                                                                                                                            |
| `ledger-reviewer` on the full diff                                      | no CRITICAL; four MAJOR — two stale lock references and a dead-code nitpick fixed in response, two recorded above as deferred with their blocks |

Not run: `forge build` / `forge test` (Part 2 unstarted, the test contracts are empty stubs), and
`docker compose config` (the Docker daemon was not running on this machine — the Postgres used for
integration testing was the local `postgresql@17`).
