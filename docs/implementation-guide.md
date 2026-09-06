# Ledgerline — Implementation Guide

> [`learning-path.md`](learning-path.md) explains **why** each piece exists.
> This document is the **execution order**: what to create, in what file, and what will need it next.

Every block below answers three questions:

1. **Why now** — what must already exist, and what is blocked until this is done
2. **Files** — exact paths, in creation order
3. **Needed by** — the specific later block that consumes this

Follow it top to bottom. Do not skip ahead: each block assumes the previous one compiles.

---

## The dependency chain

Read this once. It explains why the order is what it is.

```
1.0  App boots, connects to Postgres
      │  (nothing can be injected or persisted until this exists)
      ▼
1.1  money.ts ─────────────────────────────┐
      │  pure functions, no dependencies    │
      ▼                                     │
1.3  Ledger tables + entities               │
      │                                     │
      ▼                                     │
1.4  Balance trigger  ──┐                   │
1.5  Immutability       │ database enforces │
      │                 │ the rules         │
      ▼                 ▼                   ▼
1.6  LedgerService.post()  ◄────────────────┘
      │  THE single writer. Everything below calls it.
      │
      ├──────────────┬────────────────┬──────────────┐
      ▼              ▼                ▼              ▼
2.x Contracts    3.x Chain writer  5.x Fiat rail   4.x Indexer
      │              │                │              │
      └──────────────┴────────┬───────┴──────────────┘
                              ▼
                       6.x  The on-ramp saga
                              │  (needs ALL four above)
                              ▼
                       7.x  Reconciliation + observability
```

**The one rule that shapes everything:** `LedgerService.post()` is written once, in Block 1.6, and is
the only code in the entire repo that writes to `ledger_entries`. Every later part calls it. That is
why Part 1 comes first and why it must be right.

---

# PART 1 — The ledger

## Block 1.0 — Make the app boot and connect

**Why now.** Nothing else can happen. `app.module.ts` is currently empty, `main.ts` boots a Nest app
with no modules, and nothing opens a database connection. Every block after this one needs a running
app with a live `DataSource` to inject.

**Files.**

| Path                                        | New? | What it does                                                                                  |
| ------------------------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `apps/indexer/src/config/env.schema.ts`     | NEW  | Declares and **validates** every env var. Throws at boot on anything missing                  |
| `apps/indexer/src/config/config.module.ts`  | NEW  | Global `ConfigModule` using the schema above                                                  |
| `apps/indexer/src/app.module.ts`            | EDIT | Import `ConfigModule`, `TypeOrmModule.forRoot(dataSourceOptions)`, `ScheduleModule.forRoot()` |
| `apps/indexer/src/main.ts`                  | EDIT | `app.enableShutdownHooks()`, listen on `INDEXER_PORT`                                         |
| `apps/indexer/src/api/health.controller.ts` | EDIT | `GET /health` → `{ status, db: 'up' \| 'down' }`                                              |

**Order within the block.** Schema → module → wire into `AppModule` → health endpoint.

**The decision to get right.** The env schema must **throw**, not default. A missing
`DATABASE_URL` should crash at boot with a clear message, not silently connect to `localhost` and
appear to work. This is the "fail loud at boot" rule from `CLAUDE.md` — and boot is the only place
you can afford to be strict, so be strict there.

**Needed by.** Every block from here on. Block 1.6 injects the `DataSource`; Block 3.2 reads signing
config; Block 5.3 reads the webhook secret.

**Verify.**

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @ledgerline/indexer start:dev
curl localhost:3001/health          # → {"status":"ok","db":"up"}
```

Then delete `DATABASE_URL` from `.env` and confirm it **refuses to start**.

---

## Block 1.1 — `money.ts`

**Why now.** Pure functions with zero dependencies — no database, no Nest, no imports from the rest of
the app. That means you can build and test it in isolation, and it's ready before anything needs it.

Block 1.6 will import `splitFee` to calculate the platform fee. Block 6.4 will import `convert` to
turn dollars into tokens. Writing it now means neither of those blocks has to stop and invent it.

**Files.**

| Path                                    | New? | What it does                                             |
| --------------------------------------- | ---- | -------------------------------------------------------- |
| `packages/shared/src/types/index.ts`    | EDIT | `AmountMinor` already exists — confirm it's exported     |
| `apps/indexer/src/ledger/money.ts`      | NEW  | `add`, `sub`, `isZero`, `compare`, `splitFee`, `convert` |
| `apps/indexer/src/ledger/money.spec.ts` | NEW  | Property tests (`fast-check`)                            |

**Install first:** `pnpm --filter @ledgerline/indexer add -D fast-check`

**The signatures to write.**

```ts
// Every amount is a decimal STRING of an integer in minor units. Never a JS number.
export function splitFee(amountMinor: string, bps: number): { fee: string; net: string };

export function convert(
  amountMinor: string,
  fromDecimals: number,
  toDecimals: number,
  rateNum: string,
  rateDen: string,
): { amount: string; residual: string };
```

**Order within the block.** `add`/`sub`/`compare` first (trivial `bigint` wrappers) → `splitFee` →
`convert` → tests.

**The two things to get exactly right.**

`splitFee` — compute **one** side and derive the other:

```ts
const fee = (amount * BigInt(bps)) / 10_000n; // floor
const net = amount - fee; // derived, so fee + net === amount ALWAYS
```

Round both sides independently and you invent or destroy a cent. Deriving makes it exact by
construction, not by luck.

`convert` — return the leftover instead of dropping it. Block 1.6 will post that residual to account
`3900`. Dropped dust is the single most common reason a ledger stops balancing.

**Needed by.** Block 1.6 (`splitFee`), Block 6.4 (`convert`), Block 9.x (payout FX).

**Verify.** `pnpm --filter @ledgerline/indexer test` — the property test asserts
`fee + net === amount` across thousands of random inputs.

---

## Block 1.2 — Double-entry (concept only)

**No files.** Read [`learning-path.md` Block 1.2](learning-path.md#block-12--learn-double-entry-no-code)
and work through the $100 example on paper until the debit/credit direction is automatic.

Blocks 1.3 through 1.6 will not make sense otherwise. This is the one concept in the project that
isn't a programming concept.

---

## Block 1.3 — Ledger tables and entities

**Why now.** `money.ts` gives you the arithmetic; now you need somewhere to put the results.

The `assets` and `ledger_accounts` tables already exist from the Phase 0 migration — but they have
**no TypeORM entities**, so no code can read them yet. This block adds those entities plus the three
remaining tables.

**Files.**

| Path                                                                | New? | What it does                                                |
| ------------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `apps/indexer/src/ledger/entities/asset.entity.ts`                  | NEW  | Maps the existing `assets` table. **Needed for `decimals`** |
| `apps/indexer/src/ledger/entities/ledger-account.entity.ts`         | NEW  | Maps existing `ledger_accounts`                             |
| `apps/indexer/src/ledger/entities/ledger-transaction.entity.ts`     | NEW  | One business event                                          |
| `apps/indexer/src/ledger/entities/ledger-entry.entity.ts`           | NEW  | The debit/credit lines                                      |
| `apps/indexer/src/ledger/entities/ledger-account-balance.entity.ts` | NEW  | Calculated totals                                           |
| `apps/indexer/src/migrations/<ts>-CreateLedgerTables.ts`            | NEW  | Creates the three new tables                                |
| `apps/indexer/src/ledger/ledger.module.ts`                          | EDIT | `TypeOrmModule.forFeature([...])`                           |

**Order within the block.** Migration first (so the tables exist) → entities → register in the module.

**Why `asset.entity.ts` matters more than it looks.** `convert()` needs to know that USD has 2
decimals and USDX has 6. That fact lives in the `assets` table. Without this entity, Block 1.6 has no
way to read it and you'd be tempted to hardcode `6` somewhere — which is exactly the bug that breaks
the day you add a second token.

**The column that carries the whole idempotency story.**

```sql
CONSTRAINT ledger_transactions_cause_uk UNIQUE (kind, cause_type, cause_id)
```

Read it as: _"the posting caused by webhook `evt_123` may exist exactly once."_ Block 5.4 will rely on
this — when a duplicate webhook arrives, the second `post()` hits this constraint and fails harmlessly.
**You will never write "have I already processed this?" logic.** You cannot process it twice.

**Needed by.** Block 1.4 (the trigger attaches to `ledger_entries`), Block 1.6 (the service writes
these), Block 7.1 (reconciliation reads them).

**Verify.**

```bash
make migrate
psql ... -c "\d ledger_entries"
pnpm --filter @ledgerline/indexer migration:revert && make migrate   # round-trip
```

---

## Block 1.4 — The balance trigger

**Why now.** The tables exist, but right now nothing stops you inserting a debit with no matching
credit. This block makes that **impossible** — before any code can write to those tables in Block 1.6.

Order matters: build the guardrail before the thing that drives past it.

**Files.**

| Path                                                       | New? | What it does                 |
| ---------------------------------------------------------- | ---- | ---------------------------- |
| `apps/indexer/src/migrations/<ts>-LedgerBalanceTrigger.ts` | NEW  | The function and the trigger |
| `apps/indexer/test/ledger-constraints.integration-spec.ts` | NEW  | Proves it rejects            |

**What goes in the migration.**

```sql
CREATE FUNCTION assert_transaction_balances() RETURNS trigger AS $$
DECLARE bad record;
BEGIN
  SELECT asset_code,
         SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) AS residual
    INTO bad
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id
   GROUP BY asset_code HAVING SUM(...) <> 0 LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced in % by %',
      NEW.transaction_id, bad.asset_code, bad.residual;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balance_check
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED          -- ← the essential part
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balances();
```

**Why `DEFERRABLE INITIALLY DEFERRED` is load-bearing.** Entries insert one row at a time. After the
first `INSERT`, debits ≠ credits — that's normal and temporary. A non-deferred trigger fires there and
rejects a perfectly valid transaction. Deferred means "check at `COMMIT`," which is the only moment
the question is meaningful.

**And `GROUP BY asset_code`:** $100 balancing against 100 USDX is meaningless. Each currency must
balance on its own.

**Needed by.** Block 1.6 relies on this as its backstop. Block 1.8's property test is only meaningful
because this exists.

**Verify.** The integration test inserts one leg, commits, and asserts it **throws**. A passing test
here is the proof your ledger cannot silently hold a wrong number.

---

## Block 1.5 — Immutability

**Why now.** Same reasoning as 1.4 — establish the constraint before writing the code that must
respect it.

**Files.**

| Path                                                       | New? | What it does                       |
| ---------------------------------------------------------- | ---- | ---------------------------------- |
| `apps/indexer/src/migrations/<ts>-LedgerImmutability.ts`   | NEW  | Trigger + `REVOKE` + `reverses_id` |
| `apps/indexer/test/ledger-constraints.integration-spec.ts` | EDIT | Add the UPDATE/DELETE cases        |

**Three things in the migration:**

1. A trigger raising on `UPDATE` or `DELETE` of `ledger_entries` and `ledger_transactions`
2. `REVOKE UPDATE, DELETE ON ledger_entries FROM <app_role>` — belt and braces
3. `ALTER TABLE ledger_transactions ADD COLUMN reverses_id uuid NULL REFERENCES ledger_transactions(id)`

**What `reverses_id` is for.** When something is posted wrongly, you don't edit it. You post an
**opposite** transaction pointing at the original. Net effect zero; both stay visible forever. That's
how the audit trail records the mistake _and_ the fix — and it's why Block 4.4 can undo a reorg
without deleting anything.

**Needed by.** Block 4.4 (reorg reversals), Block 8.x (refund reversals), Block 7.1 (the reconciler
must never self-heal by editing).

**Verify.** `UPDATE ledger_entries SET amount_minor = 1` throws. Three lines, proves a load-bearing
claim.

---

## Block 1.6 — `LedgerService.post()`

**Why now.** Every prerequisite is in place: arithmetic (1.1), tables (1.3), and a database that
refuses to accept anything wrong (1.4, 1.5).

**This is the most-called function in the project.** Every block in Parts 5–9 calls it.

**Files.**

| Path                                                  | New? | What it does                                  |
| ----------------------------------------------------- | ---- | --------------------------------------------- |
| `apps/indexer/src/ledger/ledger.types.ts`             | NEW  | `PostingRequest`, `PostingLeg`, `LedgerCause` |
| `apps/indexer/src/ledger/account-registry.service.ts` | NEW  | Resolves `'2000' + merchantId` → `account_id` |
| `apps/indexer/src/ledger/ledger.service.ts`           | NEW  | `post()` — the single writer                  |
| `apps/indexer/src/ledger/ledger.service.spec.ts`      | NEW  | Unit tests                                    |
| `apps/indexer/src/ledger/ledger.module.ts`            | EDIT | Provide and **export** both services          |

**The shape.**

```ts
await ledger.post({
  kind: "onramp.capture",
  cause: { type: "fiat_event", id: "evt_123" }, // ← the idempotency key
  memo: "Card captured for intent abc",
  entries: [
    { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "10000" },
    { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "10000" },
  ],
});
```

**Order within the block.** Types → `AccountRegistry` → `post()` → tests.

**Why `AccountRegistry` is separate.** Callers know _"the merchant payable account"_; they should not
know its UUID. Platform accounts are singletons (`'1000'`); per-merchant accounts need
`('2000', merchantId)` and are **created on demand** the first time a merchant is paid. Keeping that
lookup out of `post()` keeps `post()` about posting.

**What `post()` does, in one transaction.**

1. Validate in TypeScript: at least two legs, balanced per asset, positive amounts
2. Insert the `ledger_transactions` header — `ON CONFLICT (kind, cause_type, cause_id) DO NOTHING`
3. **If the insert conflicted, return early.** Already posted. Not an error — the expected path when
   a webhook is redelivered
4. Insert the entries
5. Update `ledger_account_balances` (Block 1.7)
6. `COMMIT` — the deferred trigger fires here

**Why validate in TypeScript when the trigger already does it?** Different failure modes. The
TypeScript check gives a precise error naming the offending leg while you're developing. The trigger
catches everything that never went through this function — a migration, a `psql` session, a future
second code path. Two layers that fail differently is not duplication.

**Needed by.** Blocks 5.4, 6.4, 8.x, 9.x — every place money moves.

**Verify.** Post a balanced transaction; read the **entries** back. Post the same `cause` twice;
assert **one** transaction row exists and the entries are not duplicated. (Reading _balances_ back
belongs to 1.7 — `post()` does not write the projection yet.)

---

## Block 1.7 — The balances projection

**Why now.** `post()` exists but balances are stale. This block completes it — and adds the thing
Block 9 depends on.

**Files.**

| Path                                                       | New? | What it does                   |
| ---------------------------------------------------------- | ---- | ------------------------------ |
| `apps/indexer/src/ledger/balance.repository.ts`            | NEW  | Row-locking read and update    |
| `apps/indexer/src/ledger/ledger.service.ts`                | EDIT | Call it inside the transaction |
| `apps/indexer/test/ledger-concurrency.integration-spec.ts` | NEW  | The 20-vs-10 test              |

**The operation.**

```sql
UPDATE ledger_account_balances
   SET balance_minor = balance_minor + $delta, last_entry_id = $id, updated_at = now()
 WHERE account_id = $1
RETURNING balance_minor;
```

**This is not just a cache.** That `UPDATE` takes a **row lock**, which means concurrent transactions
touching the same account are forced into a queue by Postgres. One sees the balance _after_ the other
committed.

Without it, two simultaneous payouts both read "$500 available," both approve, and you've spent $1000
you don't have. **The projection is your concurrency control**, and Block 9.x will reserve treasury
float inside exactly this lock.

**Needed by.** Block 6.4 (float reservation), Block 7.1 (invariant I2), the read API.

**Verify.** Fire 20 concurrent payouts against float covering 10. **Exactly 10 succeed.** Not 11.
Also read the balances back after a posting — the half of Block 1.6's verification that needs this
block. Move the non-negative trigger's balance read onto the locked `ledger_account_balances` row
while you are here: it currently re-derives from the account's whole history on every insert
(`TODO(Block 1.7)` in `1754006400007`, and see [ADR-0017](decisions/0017-non-negative-enforcement.md)).

---

## Block 1.8 — The property test

**Why now.** Everything in Part 1 exists. This proves it holds together under sequences you'd never
think to write by hand.

**Files.**

| Path                                                      | New? | What it does                       |
| --------------------------------------------------------- | ---- | ---------------------------------- |
| `apps/indexer/test/ledger-invariants.integration-spec.ts` | NEW  | `fast-check` over random sequences |
| `.github/workflows/ci.yml`                                | EDIT | Run it in the `integration` job    |

**The rule under test.**

```
for thousands of random sequences of (capture, settle, refund, payout, chargeback):
    assert  SUM(debits) === SUM(credits)   per asset
    assert  no account with allows_negative=false went below zero
```

**Wire it into CI in the same block.** A correctness test that isn't in CI is a test that will rot.

**Needed by.** Nothing imports it — but it's the answer to _"how do you know your ledger is correct?"_
and it guards every change made from here on.

---

> **Part 1 done.** You have a ledger that is mathematically incapable of losing money, with no
> blockchain involved. Commit here: `feat(ledger): double-entry core with database-enforced balance`

---

# PART 2 — Contracts

**Why this comes before the chain writer.** Block 3.x sends transactions _to_ these contracts and
decodes _their_ custom errors. The ABIs must exist first, or you'd be writing a submitter against an
interface you're still inventing.

| Block                     | Files                                                                          | Needed by                                   |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| **2.0** Install deps      | `packages/contracts/lib/` via `forge install forge-std openzeppelin-contracts` | Everything in Part 2                        |
| **2.1** Token core        | `src/StableUSD.sol` (ERC-20, `decimals() = 6`), `test/StableUSD.t.sol`         | 2.2–2.6                                     |
| **2.2** Minter allowance  | Same files: `configureMinter`, `mint`, `ExceedsMinterAllowance`                | Block 3.5 decodes this error                |
| **2.3** Blacklist + pause | Same files: `blacklist`, `pause`, `AccountBlacklisted`, `TokenPaused`          | Block 3.6 branches on these                 |
| **2.4** `settle`          | `src/PaymentProcessor.sol` — reverts `PaymentAlreadySettled` on a duplicate id | **Block 3.4's safety net**                  |
| **2.5** Refund cap        | Same file: `refund`, `RefundExceedsCapture`                                    | Block 8.x                                   |
| **2.6** Invariant suites  | `test/StableUSD.invariants.t.sol`, `test/PaymentProcessor.invariants.t.sol`    | CI                                          |
| **2.7** Deploy + ABIs     | `script/Deploy.s.sol`, `packages/shared/src/abis/index.ts`, compose `deployer` | **Blocks 3.x and 4.x both import the ABIs** |

**The causal link worth spelling out.** Block 2.4 exists _because of_ Block 3.4. The submitter will
retry aggressively after a crash — it has to, since it can't know whether the first attempt landed.
That retry is only safe because `settle` reverts on a duplicate payment id. **Write the contract
guarantee before you write the code that depends on it.**

**Block 2.7 is a hard gate.** Without generated ABIs in `packages/shared`, Parts 3 and 4 cannot start.
Don't hand-write them — generate from `forge build` output.

---

# PART 3 — The chain writer

**Why before the indexer (Part 4).** You need transactions _on_ the chain before there's anything
worth reading _off_ it. Building the reader first means testing against an empty chain.

| Block                              | Files                                                                                                                                                  | Needed by                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **3.1** Understand the problem     | _(none — read `learning-path.md` 3.1)_                                                                                                                 | Your sanity in 3.4                  |
| **3.2** Nonce allocation           | `migrations/<ts>-ChainAccounts.ts`, `chain-writer/entities/chain-account.entity.ts`, `chain-writer/nonce.service.ts`                                   | 3.4                                 |
| **3.3** Signing                    | `chain-writer/signer/signer.port.ts`, `local-dev.signer.ts`, `kms.signer.ts`, `signing-policy.service.ts`, `entities/signing-request.entity.ts`        | 3.4                                 |
| **3.4** Sign→save→commit→broadcast | `migrations/<ts>-ChainTransactions.ts`, `entities/chain-transaction.entity.ts`, `entities/chain-tx-attempt.entity.ts`, `chain-tx-submitter.service.ts` | **Everything that writes to chain** |
| **3.5** Simulation                 | `chain-writer/simulator.service.ts`, `revert-decoder.ts`                                                                                               | 3.4 calls it first                  |
| **3.6** Watcher                    | `chain-writer/chain-tx-watcher.service.ts`                                                                                                             | 6.4                                 |
| **3.7** Gas escalation             | `chain-writer/gas-policy.ts`, `escalator.service.ts`                                                                                                   | Production realism                  |
| **3.8** Crash tests                | `test/chain-writer-crash.integration-spec.ts`                                                                                                          | CI                                  |

**Block 3.2 must precede 3.4** because the submitter's very first action is taking a nonce under a row
lock. **Block 3.3 must precede 3.4** because signing happens _inside_ that same transaction.

**The ordering inside Block 3.4 is the whole point:**

```
BEGIN
  1. lock chain_accounts row, take nonce      ← needs 3.2
  2. SigningPolicyService.check()             ← needs 3.3
  3. SignerPort.signTransaction()             ← needs 3.3
  4. INSERT chain_transactions (intent_key UNIQUE)
  5. INSERT chain_tx_attempts (raw_tx, tx_hash, broadcast_at = NULL)
COMMIT                                        ← durable BEFORE anything leaves the machine
─────────────────────────────────────────────
  6. eth_sendRawTransaction(raw_tx)
  7. UPDATE broadcast_at = now()
```

**If you write this in any other order, the block is wrong.** Everything after the `COMMIT` is
recoverable by re-broadcasting. Everything before it is safely undone by the rollback. There is no
window where you've acted without a record.

**A detail from Block 3.4 you'll need in 3.6:** `already known` and `nonce too low` from
`eth_sendRawTransaction` are **success signals**, not errors. Handle them as "yes, we have it."

---

# PART 4 — The indexer

**Why now.** Part 3 puts transactions on-chain. This reads them back and is what actually _confirms_
anything (Block 3.6 deliberately doesn't).

| Block                    | Files                                                                                                                                | Needed by |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| **4.1** `raw_events`     | `migrations/<ts>-RawEvents.ts` (**partial unique index**), `blockchain/entities/raw-event.entity.ts`, `raw-event.repository.ts`      | 4.2–4.5   |
| **4.2** Chunk loop       | `blockchain/core/{chain-client,log-fetcher,adaptive-chunker,sync-state.service,indexer.service}.ts`, `entities/sync-state.entity.ts` | 4.3       |
| **4.3** Handler registry | `blockchain/events/event-registry.service.ts`, `events/handlers/*.handler.ts`                                                        | 6.4       |
| **4.4** Reorg guard      | `blockchain/core/reorg-guard.service.ts`                                                                                             | 7.1       |
| **4.5** Replay           | `admin/replay.service.ts`, `test/replay-determinism.integration-spec.ts`                                                             | CI        |

**Block 4.1's index is not optional:**

```sql
CREATE UNIQUE INDEX raw_events_canonical_uk
  ON raw_events (chain_id, tx_hash, log_index) WHERE NOT is_orphaned;
```

Use the standard total unique key and a reorged transaction's re-insert gets silently swallowed,
leaving a row pointing at a block that no longer exists — and your confirmation depth is then counted
from a dead block. Every read goes through `raw-event.repository.ts`, which applies
`WHERE NOT is_orphaned`. **Never query the table directly** or you'll forget the filter exactly once,
which is enough.

**`raw-event.repository.ts` exists specifically so that filter has one home.**

---

# PART 5 — The fiat rail

**Why now.** Independent of Parts 3 and 4 — you could build it earlier. It goes here because Part 6
needs both rails, and the chain side is the harder one to get right while you still have energy.

| Block                   | Files                                                                                                                                           | Needed by                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **5.1** Mock PSP        | `apps/mock-psp/src/{server,payments,webhooks,faults,store}.ts`                                                                                  | 5.2–5.6, all integration tests |
| **5.2** `fiat_events`   | `migrations/<ts>-FiatEvents.ts`, `fiat/entities/fiat-event.entity.ts`, `fiat/webhook.controller.ts`                                             | 5.4                            |
| **5.3** Signature check | `fiat/webhook-signature.ts`, `fiat/webhook.controller.ts` (EDIT)                                                                                | 5.2's controller               |
| **5.4** Dispatcher      | `fiat/fiat-dispatcher.service.ts`, `sagas/transition-classifier.ts`                                                                             | 6.4                            |
| **5.5** Outbox          | `migrations/<ts>-Outbox.ts`, `outbox/entities/outbox-message.entity.ts`, `outbox.service.ts`, `outbox.worker.ts`, `outbox-handler.interface.ts` | 6.4 and everything async       |
| **5.6** Fault tests     | `test/fiat-faults.integration-spec.ts`                                                                                                          | CI                             |

**Build 5.1 before 5.2.** You need something that actually _sends_ a signed webhook before you can
build the thing that receives one. Otherwise you're testing against curl and guessing at the format.

**Block 5.2's controller is three lines of logic and that is deliberate:**

```ts
@Post("webhooks/:provider")
async receive(@Req() req: RawBodyRequest<Request>) {
  verifySignature(req.rawBody, req.headers["x-signature"]);   // 5.3
  await this.fiatEvents.insertIgnoringDuplicates(req.rawBody);
  return { received: true };                                   // 200, immediately
}
```

**No business logic here.** If you process inline, a slow database makes the PSP think you failed,
so it retries, so you process twice. Store and acknowledge; let Block 5.4's worker do the thinking.

You need `rawBody: true` in `NestFactory.create` — the signature is over the **exact bytes received**,
and re-serialized JSON has different key ordering.

**Block 5.5's structural rule.** `OutboxHandler` requires a `dedupeKey`, and that key **is** the
`Idempotency-Key` sent downstream. Enforce it in the interface so a handler author can't forget:

```ts
export interface OutboxHandler<T> {
  readonly kind: string;
  dedupeKey(payload: T): string; // not optional
  handle(payload: T, dedupeKey: string): Promise<void>;
}
```

---

# PART 6 — The on-ramp

**Why now.** This is the block that needs everything: the ledger (1.6), the contracts (2.x), the
submitter (3.4), the indexer (4.3), the fiat rail (5.4) and the outbox (5.5). Attempt it earlier and
you'll stub four things and debug all of them at once.

| Block                    | Files                                                                                                                  | Needed by     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| **6.1** Intent aggregate | `migrations/<ts>-PaymentIntents.ts`, `sagas/onramp/entities/payment-intent.entity.ts`, `sagas/onramp/onramp-status.ts` | 6.3–6.5       |
| **6.2** Idempotency      | `migrations/<ts>-IdempotencyKeys.ts`, `api/idempotency.interceptor.ts`, `api/entities/idempotency-key.entity.ts`       | 6.5           |
| **6.3** Transitions      | `migrations/<ts>-SagaTransitions.ts`, `sagas/entities/saga-transition.entity.ts`, `sagas/saga-transition.service.ts`   | 6.4, 8.x, 9.x |
| **6.4** Wire the saga    | `sagas/onramp/onramp.saga.ts`, `onramp-transitions.ts`, `handlers/*.ts`, outbox handlers                               | 6.5           |
| **6.5** API              | `api/payment-intents.controller.ts`, `merchants.controller.ts`, DTOs                                                   | 6.6           |
| **6.6** UI               | `apps/web/app/{checkout,merchant}/page.tsx`, `lib/api.ts`                                                              | Demo          |

**Block 6.1's snapshot columns are the design point.** `fee_bps_snapshot`, `fx_rate_num`/`den`,
`destination_address` are **copied in at creation and never re-read**. A merchant changing their
wallet address mid-flight must not redirect money the customer already authorised.

**Block 6.3 before 6.4** because the saga's every move is a `saga_transitions` insert. That table's
`UNIQUE(saga_type, saga_id, cause_type, cause_id)` is what makes applying the same cause twice a
database no-op — so Block 6.4 never writes "have I handled this already?"

**The wiring order inside 6.4:**

```
POST /payment-intents  → create intent (status=quoted)
                       → outbox: psp.capture         [5.5 → 5.1]
mock-psp charges       → webhook → fiat_events       [5.2]
dispatcher             → transition captured         [5.4 → 6.3]
                       → ledger.post(T1)             [1.6]
                       → reserve float (row lock)    [1.7]
                       → outbox: chain.submit        [5.5 → 3.4]
submitter              → settle() on-chain           [3.4 → 2.4]
indexer sees event     → transition chain_confirmed  [4.3 → 6.3]
                       → ledger.post(T5)             [1.6]
```

Every arrow is a block you already built. If one is missing, you'll know exactly which.

---

# PART 7 — Reconciliation and observability

| Block                    | Files                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| **7.1** Reconcilers      | `admin/reconciliation/{chain-ledger,psp,trial-balance,settlement-file}.reconciler.ts`           |
| **7.2** Metrics          | `observability/metrics.service.ts`, `metrics.interceptor.ts`                                    |
| **7.3** Dashboards       | `infra/grafana/dashboards/*.json` (replace the placeholders)                                    |
| **7.4** Alerts + runbook | `infra/prometheus/alerts.yml`, `docs/runbook.md` (both already drafted — make the metrics real) |
| **7.5** Loadgen          | `infra/loadgen/src/{index,scenarios,faults}.ts`                                                 |

**Block 7.1's non-obvious detail.** The chain reconciler must `eth_call` at **`head - CONFIRMATIONS`**,
not at `head`. Compare a settled ledger against unsettled chain state and the drift oscillates
forever, and you'll chase a bug that isn't there.

**Block 7.2 is where the label rule bites.** Never a merchant id as a Prometheus label — export the
_count_ of merchants with drift plus the worst case, and resolve _which_ merchant at alert time.

---

# Parts 8–13

Once Part 7 is done you have a complete, defensible project. See
[`build-plan.md` §3.1](build-plan.md#31-cut-order) for what to drop if time runs short.

| Part              | Depends on            | New files, roughly                                                            |
| ----------------- | --------------------- | ----------------------------------------------------------------------------- |
| **8** Refunds     | 6.x, 2.5              | `sagas/refund/*`, `migrations/<ts>-Refunds.ts`                                |
| **9** Payouts     | 6.x, 1.7 (float lock) | `sagas/payout/*`, `migrations/<ts>-Payouts.ts`                                |
| **10** Compliance | 6.4, 9.x              | `compliance/{sanctions,chain-risk,issuer-blacklist}.port.ts` + adapters       |
| **11** Chaos      | 3.8, 4.4              | `test/reorg.integration-spec.ts`, `test/rpc-disagreement.integration-spec.ts` |
| **12** Stripe     | 5.5                   | `fiat/adapters/stripe.adapter.ts`, shared port contract suite                 |
| **13** Stretch    | 9.x                   | Batching, float rebalancing, EIP-3009 UI                                      |

---

# Rules for working through this

- **One block per session.** They're sized for it.
- **Migration, then entity, then service, then test.** Every block that touches the database follows
  that order. Reverse it and you'll write code against a schema that doesn't exist yet.
- **Commit at the end of every block.** `feat(ledger): add money helpers with exact fee splitting`
- **Never skip a "Verify" step.** It's how you find out the block is actually done.
- **If a block needs something that isn't built yet, you're out of order.** Go back and check the
  dependency chain at the top.

## Where to start right now

```bash
git checkout -b feat/ledger-core
# Block 1.0 — apps/indexer/src/config/env.schema.ts
```
