# Ledgerline — Coding Conventions

> Code is read far more than it is written. Optimize for the next person (often you, in six months).
> **Clarity beats cleverness. Always.**

These are the standards every change in this repo follows. Most are enforced automatically by ESLint,
Prettier, `forge fmt`, and TypeScript `strict` mode — this doc explains the intent behind them and
covers the judgment calls tools can't make. When a rule here conflicts with a tool, the tool wins;
fix the tool config, don't work around it.

**Formatting is owned by the config files, not by this document.** `.prettierrc.json` (quote style,
indent width, print width), `eslint.config.mjs` (import order and lint rules) and
`packages/contracts/foundry.toml` (`forge fmt`) are the authorities — per `CLAUDE.md`'s "Where facts
live", restating their values here would just create a second copy to drift. Run `pnpm format:check`.

---

## 1. Guiding principles

1. **Readable > short > clever.** Never sacrifice clarity to save a line.
2. **Name things for what they mean, not how they work.** `pendingRewards`, not `pr` or `tmp2`.
3. **Small, single-purpose units.** A function does one thing; a module owns one concern.
4. **Make the happy path obvious.** Guard clauses and early returns over deep nesting.
5. **Fail loud, fail early.** Validate at boundaries (boot, request, chunk); crash on programmer
   error, handle expected errors explicitly.
6. **No dead code, no commented-out code, no `console.log` debris.** Delete it — git remembers.
7. **Consistency over personal preference.** Match the surrounding code even if you'd do it differently.

---

## 2. Naming

| Thing                                | Convention                                      | Example                                              |
| ------------------------------------ | ----------------------------------------------- | ---------------------------------------------------- |
| Files & directories                  | `kebab-case`                                    | `sync-state.service.ts`, `event-registry.service.ts` |
| TS classes, interfaces, types, enums | `PascalCase`                                    | `LedgerService`, `RawEvent`, `OnrampStatus`          |
| Variables & functions                | `camelCase`                                     | `chunkSize`, `advanceCursor()`                       |
| Constants (true constants)           | `UPPER_SNAKE_CASE`                              | `MAX_CHUNK_SIZE`, `DEFAULT_CONFIRMATIONS`            |
| Booleans                             | `is/has/should/can` prefix                      | `isPaused`, `hasReorg`, `shouldRetry`                |
| Nest classes                         | suffix by role                                  | `*.service.ts`, `*.controller.ts`, `*.module.ts`     |
| TypeORM entities                     | `PascalCase` class, `snake_case` table/column   | `class LedgerEntry` → `ledger_entries`               |
| Solidity contracts / events          | `PascalCase`                                    | `PaymentProcessor`, `event PaymentSettled(...)`      |
| Solidity functions / vars            | `camelCase`; internal/private `_`-prefixed      | `totalSupply`, `_beforeTokenTransfer()`              |
| Money-bearing names                  | carry the unit as a suffix                      | `amountMinor`, `valueWei`, `feeBps`                  |
| Database tables & columns            | `snake_case`, tables plural                     | `raw_events`, `log_index`                            |
| Prometheus metrics                   | `ledgerline_` prefix, `snake_case`, unit suffix | `ledgerline_indexer_lag_seconds`                     |
| Env variables                        | `UPPER_SNAKE_CASE`                              | `RPC_URL_PRIMARY`                                    |
| Async functions                      | verb that implies the wait                      | `fetchLogs()`, not `logs()`                          |

- No abbreviations unless they're domain-standard (`rpc`, `tx`, `db`, `id`, `abi` are fine; `usr`,
  `blk`, `cnt` are not).
- No Hungarian notation, no type suffixes (`userStr`, `amountNum`). Types live in the type system.
- Name by intent: `deduped` not `x2`; `orphanedEvents` not `arr`.

---

## 3. TypeScript

- **`strict` is non-negotiable** (`tsconfig.base.json`). No disabling `strict`, `noUncheckedIndexedAccess`,
  or `exactOptionalPropertyTypes` per-file to dodge an error — fix the code.
- **No `any`.** Use `unknown` + narrowing at boundaries. If `any` is truly unavoidable, add
  `// eslint-disable-next-line` **with a one-line reason** on the same line.
- **No non-null assertions (`!`) to silence the compiler.** Prove the value is present (guard, default,
  or type) instead. `env ?? fallback`, not `env!`.
- **Prefer `type` for shapes and unions; `interface` for objects meant to be extended/implemented.**
  Be consistent within a file.
- **`readonly` and `as const`** for data that must not change (config objects, ABIs).
- **Explicit return types on exported/public functions.** Let inference handle locals.
- **No magic numbers/strings.** Hoist to a named `const` (`CONFIRMATIONS`, `RETRY_LIMIT`).
- **Immutability by default.** `const` over `let`; derive new values rather than mutating; avoid
  mutating function arguments.
- **Discriminated unions over boolean flags** for state that has modes (`{ kind: 'live' | 'backfill' }`).
- **Handle promises.** No floating promises — `await`, `void`, or `.catch`. (ESLint enforces this.)

---

## 4. Functions & control flow

- **Guard clauses first.** Return/throw on invalid input at the top; keep the main logic un-indented.
  ```ts
  // Prefer this
  if (!row) return null;
  if (row.status === "failed") return handleFailed(row);
  return process(row);

  // Over nested if/else pyramids
  ```
- **Keep functions short and cohesive.** If you need a comment to separate "sections" inside a
  function, those sections probably want to be their own functions.
- **One level of abstraction per function.** Don't mix high-level orchestration with low-level byte
  fiddling in the same body.
- **Max ~3–4 parameters.** Beyond that, pass a single well-named options object.
- **Pure where possible.** Handlers and the chunker should be deterministic given their inputs — this
  is what makes replay and testing trivial.

---

## 5. Comments & documentation

- **Comment the _why_, not the _what_.** The code says what; comments explain intent, trade-offs, and
  non-obvious constraints.
  ```ts
  // Cursor advance + inserts MUST be one tx so a crash mid-chunk is safe to restart. (why)
  // increment i by 1                                                                   (noise — delete)
  ```
- **JSDoc on exported classes/services and any non-trivial public function** — one line on purpose,
  plus `@param`/`@returns` when they aren't self-evident.
- **Mark future work as `TODO(Phase N):`** so it's greppable against the build plan. No orphan TODOs
  without context.
- **Don't comment out code.** Delete it.
- Keep comments truthful — a stale comment is worse than none. Update them with the code.

---

## 6. Error handling

- **Distinguish expected from exceptional.** Expected (RPC timeout, range-too-large, event handler
  failure) → handle explicitly, record a metric, isolate. Programmer error (bad config, duplicate
  handler) → throw and crash at boot.
- **Never swallow errors.** No empty `catch {}`. At minimum log with context and re-throw or route to
  the dead-letter path.
- **Catch narrowly, at the right layer.** Per-event `try/catch` in dispatch (failure isolation);
  never a giant `try` around the whole loop that hides where things broke.
- **Attach context, not just the message.** Include `sync_key`, `tx_hash`, `block_number` in the log/
  span so the failure is findable. (These go in **span attributes / log fields**, never in metric labels.)
- **No secrets in errors or logs.** Redact.

---

## 7. Imports & file layout

- **Import order:** node builtins → external packages → internal `@ledgerline/*` → relative — a blank
  line between groups. (Prettier/ESLint keep this tidy.)
- **One primary export per file**, named to match the file (`indexer.service.ts` → `IndexerService`).
- **No deep relative reaching** (`../../../..`). Cross-package code goes through `@ledgerline/shared`.
- **Barrel files (`index.ts`)** only for a package's public surface — don't create them just to shorten
  imports internally.

---

## 8. NestJS specifics

- **Constructor injection only**; mark injected deps `private readonly`.
- **Thin controllers, fat services.** Controllers parse/validate input and delegate; business logic
  lives in services.
- **Validate all inbound DTOs** (class-validator / pipes). Never trust a request body or path param.
- **One module per bounded concern** (`BlockchainModule`, `ApiModule`, `AdminModule`,
  `ObservabilityModule`); export only what other modules need.
- **No business logic in `main.ts`** — bootstrap only.

---

## 9. Database & TypeORM

- **Migrations, never `synchronize: true`.** Schema changes are reviewed, versioned migrations.
- **Constraints belong in the schema, not in application hope.** Every load-bearing guarantee in this
  system is a database object: the two log dedupe keys, the cause-keyed saga uniqueness, the deferred
  balance trigger, the immutability trigger. If it is not in the schema, it is not a constraint — it
  is a convention that will be violated by a migration script at 3am.
- **Transactions for multi-write invariants.** Cursor advance + raw-event insert commit together; the
  outbox message commits with the state change that caused it.
- **Statuses are `text` + `CHECK`, never Postgres enums** — see
  [ADR-0014](decisions/0014-statuses-as-text.md). Historical `saga_transitions` rows must keep
  retired status names readable forever.
- **Parameterized queries only.** Never string-concatenate SQL.

### 9.1 Money — the rule that overrides everything else

See [ADR-0001](decisions/0001-money-representation.md). This is not stylistic; a violation is a
money-loss bug.

- Every amount is an **integer in the minor unit of a named asset**: `numeric(38,0)` in Postgres,
  `string` in TypeScript, `bigint` only _inside_ arithmetic helpers.
- **Never JS `number` for an amount.** Not for display, not "just this once", not for a comparison.
- **An arithmetic expression may only combine amounts with the same `asset_code`.** Scale belongs to
  the asset (via the `assets` table), never to the row.
- **Cross-asset movement is never a subtraction.** It is two balanced ledger transactions joined by
  the FX clearing pair. "Sums to zero" across different units is not an invariant.
- **Exactly one function may change scale:** `convert()`, which returns `{ amount, residual }`. The
  residual is **journaled** to `3900 rounding_residual`, never dropped. Dust that is silently
  discarded is the thing that makes a trial balance drift.
- Column and variable names carry the unit: `*_minor`, `*_wei`, `*_bps`.

### 9.2 Metric label cardinality — a hard boundary

The permitted label set is enumerated in [`observability.md`](observability.md) §1 and is
**exhaustive**. Never a merchant id, customer id, address, tx hash, payment id or idempotency key as
a Prometheus label.

That is not a stylistic preference — unbounded label cardinality is how you take down a Prometheus.
When an invariant is genuinely per-entity (I5, per-merchant drift), export the **aggregate** (a count
and a maximum) and resolve the entity id **at alert time** into the annotation. High-cardinality
identifiers belong in **span attributes and structured logs**, where cardinality is free and where
you actually need them during an incident.

---

## 10. Solidity

- **`forge fmt` is the formatter** (4-space indent, configured in `foundry.toml`).
- **Explicit visibility and state mutability** on every function (`external`, `public`, `view`, `pure`).
- **Checks-Effects-Interactions** order; update state before external calls.
- **Custom errors over `require` strings** (cheaper, clearer): `error NotOwner();`.
- **NatSpec** (`/// @notice`, `/// @param`) on public/external functions and events.
- **Events carry full context** (amount + resulting total) — a deliberate design choice so off-chain
  handlers are self-contained. Keep it.

---

## 11. Testing

- **Test behavior, not implementation.** Assert outcomes and invariants, not private internals.
- **Arrange–Act–Assert**, one logical assertion per test, descriptive names:
  `it("re-applies a duplicate event as a no-op")`.
- **Deterministic tests.** No reliance on wall-clock, ordering, or network flakiness.
- **The load-bearing tests for this project** — non-negotiable, in order of value:
  1. **Crash injection on the chain write path** (kill at each `CrashPoint` → exactly one mined tx).
  2. **Trial balance** (property test: `Σ debits = Σ credits` per asset after every commit).
  3. **Idempotency** at all three levels: the same webhook, the same API call, the same `intent_key`.
  4. **Replay determinism** (ingest → snapshot → truncate → rebuild → deep-equal).
  5. **The saga compensation matrix** — one row per `(saga_type, failure_injection_point)`. This
     table _is_ the state-machine spec, made executable.
  6. **Reorg orphaning**, within and beyond confirmation depth.
- **Every entry in [`failure-modes.md`](failure-modes.md) names the test that proves it.** An entry
  with no test is a claim, not a design. If you add a failure mode, add its test in the same commit.
- **Solidity:** a unit test per function **plus** an invariant suite with a bounded handler and ghost
  accounting — `Σ balances == totalSupply`, `balanceOf(processor) == 0` after every action, minter
  allowance never exceeded, `decimals() == 6`.

---

## 12. Git & commits

- **Conventional Commits**, enforced by commitlint:
  `type(scope): summary` → e.g. `feat(indexer): add adaptive chunk sizing`.
  Types: `feat, fix, refactor, test, docs, chore, ci, perf, build`. Scopes:
  `indexer, ledger, sagas, fiat, chain, compliance, mock-psp, web, contracts, shared, infra, docs,
ci, deps, repo`.
- **Small, atomic commits** that each leave the repo in a working state. One logical change per commit.
- **Imperative mood** in the summary ("add", not "added"/"adds"), ≤ ~72 chars, no trailing period.
- **Never commit** secrets, `.env`, `node_modules`, build output, or generated `lib/`/`out/`.
- Run `pnpm lint && pnpm typecheck` before committing (husky runs lint-staged automatically).

---

## 13. The checklist (before you open a PR / commit)

- [ ] Names read like plain English; no abbreviations or magic values.
- [ ] Functions are small, single-purpose, and use guard clauses.
- [ ] No `any`, no `!`-assertions, no floating promises, no dead/commented code.
- [ ] Comments explain _why_; TODOs are `TODO(Phase N):`.
- [ ] Errors are handled at the right layer with context; nothing swallowed.
- [ ] New indexer/API paths have a metric (and a span where it tells a story).
- [ ] Tests cover the behavior; idempotency/replay respected where relevant.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm format:check` (and `forge fmt --check`) are clean.
- [ ] Conventional commit message.
