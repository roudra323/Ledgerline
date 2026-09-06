# Ledgerline — Architecture Walkthrough

> **What this document is.** A plain-language, start-to-finish explanation of how Ledgerline works
> and _why_ it is shaped the way it is. `docs/architecture.md` is the reference — dense, precise,
> written for someone who already knows the domain. This document is the same content taught from
> zero, in order, with nothing skipped.
>
> **What it is for.** Reviewing the system step by step to find bugs. Each section ends with a
> **🔍 Review checkpoint** — the specific things to look at hard, and (where I found them) the open
> questions in the code as it stands today.

**Read the sections in order.** Each one depends on the one before it.

| §                                                      | What it covers                                           |
| ------------------------------------------------------ | -------------------------------------------------------- |
| [1](#1-what-the-system-actually-does)                  | The business, in plain words                             |
| [2](#2-the-one-hard-problem)                           | Why this is difficult at all                             |
| [3](#3-the-nine-load-bearing-ideas)                    | The nine ideas everything else follows from              |
| [4](#4-double-entry-bookkeeping-from-zero)             | Debits and credits, taught from scratch                  |
| [5](#5-money-as-an-integer)                            | Why money is a string, and how FX avoids losing a cent   |
| [6](#6-the-data-model-table-by-table)                  | Every table, what it is for, what its key means          |
| [7](#7-the-chart-of-accounts-and-a-worked-100-payment) | The accounts, and one payment traced through all of them |
| [8](#8-the-three-flows-step-by-step)                   | On-ramp, refund, payout — every step                     |
| [9](#9-the-chain-write-path)                           | Signing, nonces, crashes, gas — the hardest part         |
| [10](#10-reorgs-and-replay)                            | When the chain rewrites history                          |
| [11](#11-reconciliation-the-invariant-set)             | The nine checks that catch everything else               |
| [12](#12-how-failures-are-handled-the-four-categories) | Dead-letter vs park vs defer vs page                     |
| [13](#13-what-is-actually-built-today)                 | Code on disk vs design on paper                          |
| [14](#14-review-checklist--where-bugs-hide)            | The consolidated hunting list                            |

---

## 1. What the system actually does

Ledgerline is a **payment rail**. It moves value in two directions:

**On-ramp (fiat → stablecoin).** A customer pays with a card. That money lands with a payment
processor (a "PSP" — think Stripe). We then deliver the merchant an equivalent amount of a
stablecoin we issue, called **USDX**, into the merchant's own wallet. The merchant is now holding
tokens they control.

**Off-ramp (stablecoin → fiat).** The merchant sends USDX back to us, we destroy those tokens
("burn"), and we send the merchant real money via bank transfer.

Two things about that are worth stating up front, because they shape everything:

1. **Settlement is non-custodial.** When we settle a merchant, the tokens go into the merchant's own
   wallet, not into an account we control. We cannot claw them back. That single fact is what makes
   every "what if we need to undo this?" question genuinely hard rather than a database rollback.

2. **We are not the interesting part.** The token transfer is close to a solved problem. The
   difficulty is entirely in the seams: between us and the PSP, and between us and the chain.

### The three parties in every sentence below

| Party     | Who                                                | Do we control it? |
| --------- | -------------------------------------------------- | ----------------- |
| **PSP**   | The card processor. `apps/mock-psp` in dev.        | ❌ No             |
| **Chain** | The blockchain. Anvil (a local test chain) in dev. | ❌ No             |
| **Us**    | `apps/indexer` — the NestJS app, plus Postgres.    | ✅ Yes            |

---

## 2. The one hard problem

Here it is in one sentence:

> **We have two independent sources of truth, we control neither of them, neither can undo the
> other, and both of them lie to us about finality.**

Unpack that:

**"Two independent sources of truth."** The PSP knows whether the card was charged. The chain knows
whether the tokens moved. Neither knows about the other. There is no shared transaction that spans
both. If you charge the card and then the token transfer fails, no database can roll that back for
you — the money genuinely left the customer's account.

**"Both retry."** The PSP will send you the same webhook five times if it doesn't get a clean `200`.
Your own code will re-broadcast a blockchain transaction if it isn't sure the first one landed. Every
single message in this system can arrive more than once.

**"Both deliver out of order."** A refund webhook can arrive before the capture webhook it refunds.
Chain events for block 100 can be processed before block 99 if you're careless. Your state machine
must handle "this event is for a state I'm not in yet."

**"Both lie about finality."** A blockchain confirmation is probabilistic — a block can be
un-mined ("reorged") and the transaction inside it can vanish or move. And fiat has the same problem,
just slower: an ACH transfer can be _returned_ three days after it "settled", and a card payment can
be _charged back_ months later.

Everything in the rest of this document is a consequence of those four facts:

| The fact                              | What it forces                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Two sources of truth                  | Reconciliation invariants (§11), and drift metrics that actually mean something         |
| Neither supports a shared transaction | Sagas with real compensation, ordered so the recoverable failure is last (§8)           |
| Both retry                            | Idempotency at four layers, from HTTP down to a contract revert (§3.3)                  |
| Some steps cannot be undone           | An explicit irreversibility map, and compensations that end in a debt entry and a human |
| "Confirmed" ≠ "final"                 | Confirmation depth as a **risk budget**, and reorgs that self-heal (§10)                |

---

## 3. The nine load-bearing ideas

These are the rules in `CLAUDE.md`, explained. If you understand these nine, you understand the
system; everything else is detail.

### 3.1 Two logs, one discipline

There are two **append-only logs**:

- `raw_events` — every event we saw on the chain.
- `fiat_events` — every webhook we received from the PSP.

"Append-only" means: rows go in, rows never change, rows never get deleted. `UPDATE` and `DELETE` are
actually revoked on these tables at the database level, so it isn't a convention — it's enforced.

Everything else in the system — every balance, every saga's current status, every merchant's
blacklist state — is a **projection**: a derived, disposable summary that can be thrown away and
rebuilt from the two logs. This is the single most important structural idea in the codebase.

**Why this matters.** If a projection is wrong because of a bug, you fix the bug, delete the
projection, and replay it. If your _log_ is wrong, you have lost money and there is no recovery. So
all the paranoia is concentrated on the logs, and the projections are allowed to be simple.

**The webhook endpoint does exactly three things:**

```
1. Verify the HMAC signature over the raw request body
2. INSERT INTO fiat_events ... ON CONFLICT DO NOTHING
3. Return 200
```

No business logic. No saga advancement. No ledger writes. A separate worker picks the row up
afterwards.

**Why that specifically?** Because it turns three classes of incident into non-events:

- A **duplicate** webhook hits `ON CONFLICT DO NOTHING` and vanishes.
- A webhook that arrives **too early** (before we've even committed our own record of the payment)
  still gets stored — we just process it later, when the aggregate exists.
- A webhook that would have **crashed** our business logic no longer crashes the HTTP request, so the
  PSP doesn't start a retry storm.

Compare with the naive version: doing the work inline in the HTTP handler. Then a bug in your saga
code returns a `500`, the PSP retries, your bug fires again, and now you have an outage that's also
producing duplicate work.

> **🔍 Review checkpoint.** Anywhere you find business logic creeping into the webhook controller, or
> a code path that returns a non-2xx to the PSP for anything other than a bad signature, that is a
> bug. The one and only legitimate rejection is a failed HMAC.

### 3.2 Nothing is credited on a hint

A **hint** is anything that suggests something happened. A transaction receipt. An HTTP `200`. Your
own optimistic write.

A **fact** is a confirmed, indexed event from the source of truth itself.

**Sagas only ever advance on facts.** We submit a transaction to the chain, and then we _wait for the
indexer to observe the resulting event at confirmation depth_ before we mark the merchant as settled.
We do not use the receipt that `eth_sendRawTransaction` eventually gives us, even though it's sitting
right there and it would be so much easier.

**Why?** Because a receipt tells you a transaction was included in _a_ block. It doesn't tell you
that block survived. This is exactly the bug that has drained crypto exchanges: credit on the
receipt, the chain reorgs, the deposit never really happened, the user already withdrew.

**The one exception.** If `receipt.status = 0` — the transaction _reverted_ — we do act on it
directly. We have to: a reverted transaction emits no events at all, so the event path can never
learn about it. But note the asymmetry, which is the whole trick:

> A revert can only ever drive a saga **toward compensation**, never toward crediting anyone.

Acting on a hint to undo something is safe. Acting on a hint to give someone money is not.

**Confirmation depth is a risk policy, not a constant.** Different actions get different depths
depending on how bad it would be to get them wrong:

| Action        | Depth on Anvil | Why                                                   |
| ------------- | -------------- | ----------------------------------------------------- |
| `settle`      | 2              | Reversible-ish — we can pursue the merchant           |
| `payout_burn` | 4 (2× settle)  | Triggers an **irreversible** fiat transfer afterwards |

### 3.3 The ledger balances, and the database enforces it

The ledger is double-entry (§4 teaches this from scratch if it's new to you). Three enforcement
layers, all inside Postgres — not in application code:

**Layer 1 — Immutability.** A `BEFORE UPDATE OR DELETE` trigger raises an exception on
`ledger_entries` and `ledger_transactions`. On top of that, `UPDATE`/`DELETE` are revoked from the
application's database role. Corrections happen by posting a **reversing transaction** that cancels
the original out, never by editing the original.

There's a subtlety here that the project actually got wrong once and then fixed
(see the 2026-08-30 log entry in `docs/progress.md`): **in Postgres, a table's owner bypasses
`REVOKE` entirely.** So revoking `UPDATE` from the role that owns the table enforces exactly nothing
while looking like security. The fix was a second role, `ledgerline_app`, which the running
application connects as, while migrations run as the owner. The trigger is the real enforcement — it
fires for owners too — and the `REVOKE` is a genuine second layer only because of that role split.

**Layer 2 — Balance.** A `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` fires at `COMMIT` and
asserts `SUM(debits) = SUM(credits)`, **grouped by asset**.

"Deferred" is load-bearing. Entries are inserted one row at a time. After you insert the first leg of
a two-leg posting, the books are momentarily unbalanced _by design_. A normal (non-deferred) trigger
would reject that first insert. A deferred one waits until you say `COMMIT` and checks the finished
state.

**Layer 3 — Non-negative.** The same trigger function rejects the commit if any account marked
`allows_negative = false` ended up below zero. Some accounts _are_ allowed to go negative — the FX
clearing accounts pass through negative states mid-conversion by design — so it's a per-account flag,
not a global rule.

> **Why put this in the database instead of in TypeScript?** Because a ledger whose balances merely
> _should_ balance is worse than no ledger — it makes a claim it doesn't back. Application-level
> checks are bypassed by the next developer who writes a quick script, a migration, or a
> "just this once" manual fix. The trigger cannot be bypassed.

> **🔍 Review checkpoint — real observations in the current code.**
>
> - `assert_transaction_balances()` is `FOR EACH ROW`. A posting with 5 legs runs the whole
>   aggregation query 5 times at commit, each time re-scanning that transaction's entries. Correct,
>   but O(legs²). A `FOR EACH STATEMENT` constraint trigger would run once — worth checking whether
>   deferred statement-level triggers give you the `NEW` access this function needs (they don't, which
>   is likely why it's per-row; but the trade-off should be a conscious one).
> - The non-negative check in `1754006400004-LedgerNonNegativeCheck.ts:46` does
>   `SUM(...) FROM ledger_entries WHERE account_id = NEW.account_id` — with **no `asset_code` filter
>   and no time bound**. It re-aggregates that account's _entire history_ on every single entry
>   insert. Two consequences: (a) it gets linearly slower forever, and (b) once
>   `ledger_account_balances` exists (Block 1.7), there will be two independent ways to compute a
>   balance, which can disagree. Note the missing asset filter is probably harmless today because
>   `ledger_accounts` are per-asset — but that's an invariant held elsewhere, not by this query.

### 3.4 Money is an integer minor unit of a named asset

Never a floating-point number. Never a JS `number`. Full treatment in §5.

### 3.5 Order compensations so the recoverable failure is last

When a multi-step flow fails halfway, you have to undo the steps you already did. The order you undo
them in determines what happens when the _undo itself_ fails.

**Refund:** claw the tokens back from the chain **first**, then refund the card.

- If the chain step fails → the customer's refund is delayed. That's an SLA problem. Annoying,
  recoverable, you retry.
- If you'd done fiat first and the chain step failed → the customer has their money back _and_ the
  merchant still has the tokens. You have paid out twice. That's a solvency problem with no recovery
  path.

**Payout:** burn the tokens **first**, then send the bank transfer.

- Same logic. Fiat-first plus a failed burn means the merchant holds the cash and the tokens.

**The general rule:** everything reversible — screening, limit checks, float reservation, transaction
simulation — happens strictly _before_ the first irreversible step. And when you must sequence two
irreversible things, put the one you can retry last.

> A saga's compensation is not "undo". It is "the best available economically equivalent action" —
> and sometimes that action is a debt entry on the merchant's account and a human being reading an
> alert.

### 3.6 Sign and persist before you broadcast

Full treatment in §9. The short version: the signed transaction bytes get committed to Postgres
_before_ they're sent to the chain, so a crash at any point leaves a recoverable state.

### 3.7 Fail loud at boot, isolate at runtime, park rather than fail

Three different failure responses for three different kinds of problem:

| Kind of problem                                             | Response                               | Why                                                                                           |
| ----------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Bad config, missing env var, duplicate handler registration | **Crash at startup**                   | These are always programmer error. Failing at boot is loud and costs nothing.                 |
| One event handler throws                                    | **Dead-letter that event, keep going** | One bad event must not stop the indexer for every other payment.                              |
| Out of gas / out of float / screening vendor down           | **Park the saga in a named state**     | Nothing is wrong with the payment. Retrying just burns attempts until it hits `max` and dies. |

That third one is the subtle one. If a payout can't proceed because the treasury has no USDX, that is
not a failure of the payout — it's a resource shortage. If you treat it as a failure and retry with
backoff, you will exhaust `max_attempts` and dead-letter a perfectly good payment. So it goes into
`awaiting_liquidity` instead: a named, visible, alertable state that resumes when float arrives.

### 3.8 Fail closed on compliance

If the sanctions-screening check cannot be completed — the vendor is down, the request timed out —
**we do not proceed**. We never credit or pay out on an unavailable screening result.

The reasoning is an asymmetry of cost. A wrongly-allowed sanctioned transaction is an unbounded
liability (regulatory, reputational, potentially criminal). A wrongly-delayed legitimate transaction
is a support ticket.

### 3.9 Never log secrets; never use high-cardinality metric labels

Prometheus creates a separate time series for every unique combination of label values. If you label
a metric with `merchant_id`, you get one time series per merchant — and Prometheus falls over. So the
permitted label set in `docs/observability.md` §1 is **exhaustive** and closed. No merchant IDs,
customer IDs, wallet addresses, transaction hashes, or payment IDs as labels — ever.

Those values are genuinely useful for debugging, so they go in **span attributes** (traces) and
**structured logs**, both of which handle high cardinality fine.

---

## 4. Double-entry bookkeeping from zero

Skip this section if you already know debits and credits. If you don't, everything below §4 will be
confusing without it.

### The core idea

Money never appears and never vanishes. It only **moves between accounts**. So every time you record
a movement, you record it **twice**: once for where it came from, once for where it went. Those two
halves must be equal.

The two halves are called **debit** and **credit**. Forget any intuition you have that debit means
"decrease" and credit means "increase" — that intuition comes from bank statements, which are written
from the _bank's_ point of view, and it will actively mislead you here.

**Debit and credit are just names for the two sides.** Left and right. What they _mean_ depends on
the type of account.

### The five account types and their "normal side"

Each account has a **normal side** — the side that increases it.

| Account type  | What it is                                | Normal side | Example                             |
| ------------- | ----------------------------------------- | ----------- | ----------------------------------- |
| **Asset**     | Something we own or are owed              | **Debit**   | `bank_settlement`, `token_treasury` |
| **Liability** | Something we owe to someone else          | **Credit**  | `merchant_payable`                  |
| **Equity**    | The residual — internal/clearing accounts | **Credit*** | `rounding_residual`                 |
| **Revenue**   | Money we earned                           | **Credit**  | `fee_revenue`                       |
| **Expense**   | Money we spent                            | **Debit**   | `gas_expense`                       |

\* Equity is credit-normal by convention, but Ledgerline seeds the two `fx_clearing` accounts
(`1800`, `1810`) as `equity` with `normal_side = 'debit'`, while `3900 rounding_residual` is
`equity`/`credit`. So **don't infer an account's normal side from its type** — read the
`normal_side` column, which is what the non-negative trigger actually uses. `1800`, `1810` and
`3900` are also the only accounts seeded `allows_negative = true`: they are transient by nature and
must never block a posting.

So:

- Debit an **asset** → we have more of it.
- Credit an **asset** → we have less of it.
- Credit a **liability** → we owe more.
- **Debit** a **liability** → we owe **less**. ← this one trips everyone up, see below.

In `ledger_accounts` this is the `normal_side` column, and it's what the non-negative trigger uses to
work out which direction counts as "positive" for that particular account.

### The rule that makes it useful

> For every transaction: **Σ debits = Σ credits.**

If they don't match, you made a mistake — you recorded money coming from nowhere or going nowhere.
That's not an accounting nicety; it is a **checksum on your business logic**. The deferred trigger in
§3.3 is that checksum, enforced.

And because Ledgerline handles several assets, the rule is stricter: **Σ debits = Σ credits _per
asset_.** You may not balance 100 USD against 100 USDX — those are different things and pretending
otherwise is how you lose track of an FX exposure. §5 covers how cross-asset movement actually works.

### The one that confuses everyone

In §7 you'll see the settlement posting **debit** `merchant_payable`. That looks backwards: we're
paying the merchant, surely that should credit them?

No. `merchant_payable` is a **liability** — it records what we _owe_ the merchant. Its normal side is
credit, so crediting it means "we now owe more."

When we actually deliver the tokens to the merchant's wallet, we no longer owe them — the debt is
discharged. Discharging a liability makes it smaller, and making a liability smaller is a **debit**.

The mental model: `merchant_payable` is an IOU. Crediting it writes the IOU. Debiting it tears the
IOU up because you paid.

---

## 5. Money as an integer

### The representation

Money is **always** an integer count of the smallest unit of a named asset:

| Layer      | Type            | Example                        |
| ---------- | --------------- | ------------------------------ |
| Postgres   | `numeric(38,0)` | `10000`                        |
| TypeScript | `string`        | `"10000"`                      |
| Arithmetic | `bigint`        | `10000n` — inside helpers only |

`$100.00` is `"10000"` — ten thousand cents. `100 USDX` (6 decimals) is `"100000000"`.

**JavaScript `number` is forbidden for money.** Not discouraged — forbidden. `0.1 + 0.2` is
`0.30000000000000004` in IEEE 754 floating point, and any system where that can happen to a monetary
value will eventually be off by a cent, and then off by a cent in a way that can't be traced.

`bigint` is exact but doesn't survive `JSON.stringify`, so `string` is the transport and storage
form, with `bigint` used only inside `apps/indexer/src/ledger/money.ts`.

**Arithmetic may only combine amounts of the same `asset_code`.** Adding USD to USDX is meaningless.

### Fees: derive, never compute twice

From `money.ts:56`:

```ts
const fee = (amount * BigInt(bps)) / 10000n; // floor division
const net = amount - fee; // derived by subtraction
```

The important part is the second line. If you computed `net` independently as
`amount * (10000 - bps) / 10000`, then rounding could make `fee + net ≠ amount` and you'd have
invented or destroyed a cent. Deriving `net` by subtraction makes `fee + net === amount` **true by
construction**, for every input, always.

### FX: two transactions and a clearing pair

Converting USD to USDX is **never a subtraction**. You cannot debit a USD account and credit a USDX
account in one balanced posting, because then neither asset balances on its own.

Instead, the two sides are joined through a pair of **clearing accounts**:

- `1800 fx_clearing:USD`
- `1810 fx_clearing:USDX`

The USD side of the trade balances against `1800`. The USDX side balances against `1810`. Each asset
balances within itself, and the clearing pair records that a conversion happened. §7's worked example
shows this concretely.

### Rounding residuals are journaled, never dropped

`convert()` in `money.ts:84` returns `{ amount, residual }` — the converted value _and_ the leftover
that didn't divide evenly:

```ts
const converted = totalNumerator / totalDenominator; // floor
const residual = totalNumerator % totalDenominator; // the dust
```

That residual is posted to `3900 rounding_residual`. It is never rounded away and never silently
dropped. **This is what keeps the trial balance at exactly zero forever** rather than at "zero plus a
few cents of accumulated dust", which is the state most homegrown ledgers end up in.

> **🔍 Review checkpoint.** `convert()` computes `residual` as a remainder in the units of
> `totalDenominator`, not in units of the target asset. Confirm the caller that journals it to `3900`
> converts it into a real asset amount first, or that `3900` is documented as holding
> denominator-scaled dust. Getting this wrong would balance the books numerically while making the
> residual account meaningless. Block 1.1's property tests cover `fee + net === amount`; check
> whether an equivalent round-trip property exists for `convert` (`amount * den + residual` relates
> back to the input).

---

## 6. The data model, table by table

### 6.1 The logs and their projections

| Table                     | What it holds                       | Key, and what the key buys you                               |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `raw_events`              | Every chain event we've seen        | `UNIQUE(chain_id, tx_hash, log_index) WHERE NOT is_orphaned` |
| `fiat_events`             | Every PSP webhook we've received    | `UNIQUE(provider, provider_event_id)`                        |
| `saga_transitions`        | Every state change of every saga    | `UNIQUE(saga_type, saga_id, cause_type, cause_id)`           |
| `ledger_transactions`     | The header of a balanced posting    | `UNIQUE(kind, cause_type, cause_id)`                         |
| `ledger_entries`          | The individual debit/credit legs    | `UNIQUE(transaction_id, sequence)`                           |
| `ledger_account_balances` | Running totals — **a projection**   | `account_id`                                                 |
| `blacklist_status`        | Who's blocked — **a projection**    | `(chain_id, address)`                                        |
| `sync_state`              | "We've indexed up to block N"       | `sync_key`                                                   |
| `indexer_failures`        | Dead letter for handlers that threw | FK → `raw_events`                                            |

**Those unique keys are not housekeeping — each one is a specific defence.** Read them again:

- `fiat_events` unique on `(provider, provider_event_id)` → **duplicate webhooks are impossible.**
- `saga_transitions` unique on `(saga_type, saga_id, cause_type, cause_id)` → **applying the same
  cause to the same saga twice is a no-op at the _database_ level, not the application level.** This
  is the entire orchestration idempotency story in one index. Even if your dispatcher has a bug and
  fires twice, the second one hits the unique constraint.
- `ledger_transactions` unique on `(kind, cause_type, cause_id)` → **the same cause can only ever
  produce one posting.** Webhook redelivery cannot double-credit.

#### The `raw_events` partial-unique fix — a real bug, caught in design

The original design had a **total** unique index on `(chain_id, tx_hash, log_index)`.

Here's why that's broken for a payment system. When a chain reorgs, the same transaction is very
often re-included — in a _different block_. So you get a second event with the same
`(chain_id, tx_hash, log_index)` but a new `block_number` and `block_hash`.

With a total unique index, the re-insert hits `ON CONFLICT DO NOTHING` and is silently discarded. The
row that survives is the **orphaned** one, carrying a stale `block_number`. And confirmation depth is
computed as `current_block - block_number`. So your payment's confirmation math is now running off a
block that no longer exists on the canonical chain.

The fix is a **partial** unique index — `WHERE NOT is_orphaned` — which lets the orphaned copy and the
canonical copy coexist as separate rows. See [ADR-0010](decisions/0010-raw-events-partial-unique.md).

> **🔍 Review checkpoint.** This is the flavour of bug worth hunting for elsewhere: a uniqueness
> constraint that is correct for the happy path and silently wrong under a specific failure. Ask of
> every unique key in the table above: _what happens when a legitimate second row wants to exist?_

### 6.2 Aggregates, rails and control

| Table                       | What it is for                                                          |
| --------------------------- | ----------------------------------------------------------------------- |
| `assets`                    | `USD` (2dp) · `USDX` (6dp) · `ETH` (18dp)                               |
| `merchants`, `customers`    | The counterparties — KYB/KYC status, freeze flags                       |
| `payment_intents`           | The on-ramp saga's state, with a **frozen pricing snapshot**            |
| `refunds`                   | The refund saga — N partial refunds per payment, independent lifecycles |
| `payouts`, `payout_batches` | The off-ramp saga                                                       |
| `outbox_messages`           | One queue for all outbound work, `FOR UPDATE SKIP LOCKED`               |
| `chain_accounts`            | Per-role nonce counter + a freeze switch                                |
| `chain_transactions`        | One _logical_ transaction: `UNIQUE(intent_key)`                         |
| `chain_tx_attempts`         | One row per **broadcast** — `raw_tx` saved before sending               |
| `idempotency_keys`          | `(scope, key)` → request hash + the stored response                     |
| `screening_checks`          | Immutable compliance audit, with `list_version` + `list_sha256`         |
| `limit_counters`            | Velocity controls, read under a row lock                                |
| `signing_requests`          | Audit trail for the signing-policy layer                                |
| `liquidity_positions`       | Float min/target/max per asset                                          |
| `chain_fingerprint`         | Genesis hash — **refuses to boot if the chain was wiped under us**      |

Two of these deserve a note.

**`chain_fingerprint`.** In development, it's easy to `docker compose down` Anvil (wiping the chain
back to block 0) while Postgres keeps its data. Now your database believes it has indexed 5,000
blocks of a chain that no longer exists, and it will happily "resume" from block 5,000 on a chain
that's at block 3. Storing the genesis hash and refusing to start when it changes turns a confusing
multi-hour debugging session into a clear error at boot.

**Snapshotting.** `destination_address`, `fee_bps_snapshot`, `fx_rate_num`/`fx_rate_den`,
`quote_expires_at` are all copied onto the aggregate when it's created and **never re-read from
config**. If someone changes the fee from 1% to 2% while a payment is in flight, that payment must
still settle at the 1% it was quoted at. A payment's economics are frozen at quote time.

> **🔍 Review checkpoint.** Every read of a config value inside a saga step is a potential bug. The
> question to ask at every one: _would this payment behave differently if the config changed between
> its creation and this line running?_ If yes, it should have been snapshotted.

---

## 7. The chart of accounts, and a worked $100 payment

### The accounts

Seeded by migration `1754006400000-AssetsAndChartOfAccounts.ts`. Codes follow standard accounting
convention: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx+ expenses.

| Code        | Name                                     | Type      | Asset      | What it means                              |
| ----------- | ---------------------------------------- | --------- | ---------- | ------------------------------------------ |
| 1000        | `psp_receivable`                         | asset     | USD        | The PSP has our money but hasn't paid out  |
| 1010        | `bank_settlement`                        | asset     | USD        | Real cash in our bank account              |
| 1100        | `token_treasury`                         | asset     | USDX       | Tokens we hold, unallocated                |
| 1150        | `token_in_transit`                       | asset     | USDX       | Tokens reserved for an in-flight payment   |
| 1200        | `gas_wallet`                             | asset     | ETH        | ETH for paying transaction fees            |
| 1300        | `merchant_receivable` _(per merchant)_   | asset     | USD        | A merchant owes **us** (e.g. a chargeback) |
| 1800 / 1810 | `fx_clearing`                            | equity    | USD / USDX | The conversion bridge (§5)                 |
| 2000        | `merchant_payable` _(per merchant)_      | liability | USDX       | Tokens we owe a merchant                   |
| 2010        | `merchant_fiat_payable` _(per merchant)_ | liability | USD        | Cash we owe a merchant                     |
| 2100        | `unsettled_capture`                      | liability | USD        | Captured, not yet turned into tokens       |
| 2200        | `frozen_payable` _(per merchant)_        | liability | USDX       | Owed, but frozen (compliance)              |
| 2500        | `stablecoin_issued`                      | liability | USDX       | **Every USDX in existence is our debt**    |
| 3900        | `rounding_residual`                      | equity    | per asset  | FX dust (§5)                               |
| 4000        | `fee_revenue`                            | revenue   | USD        | Our cut                                    |
| 5000 / 5010 | `psp_fee_expense` / `gas_expense`        | expense   | USD / ETH  | What the rails cost us                     |
| 9000        | `chargeback_loss`                        | expense   | USD        | Money genuinely gone                       |

Note **2500 `stablecoin_issued` is a liability.** That's the honest framing of a stablecoin: every
token in circulation is a claim against us. Its balance should always equal the token contract's
`totalSupply()` — which is exactly what reconciliation check I3 verifies (§11).

The four per-merchant codes (1300, 2000, 2010, 2200) are **not** seeded. They're created on demand the
first time a merchant needs one, by `AccountRegistryService` — so onboarding a merchant doesn't have
to pre-provision four ledger rows for accounts they may never use.

### A $100.00 on-ramp, 1% fee, 1:1 FX

Four postings. Watch how each one balances **within a single asset**.

**T1 — the card is captured.** The PSP now holds $100 of the customer's money on our behalf.

```
DR 1000 psp_receivable      USD    10000     ← asset up: the PSP owes us $100
CR 2100 unsettled_capture   USD    10000     ← liability up: we owe someone $100
                                   -----
                            USD balances ✅
```

We took money but haven't decided what it becomes yet, so it sits as an undifferentiated obligation.

**T3 — fee split and FX.** Here's the interesting one. Two assets, four legs, balancing separately.

```
DR 2100 unsettled_capture   USD    10000     ← discharge the obligation from T1
CR 4000 fee_revenue         USD      100     ← our 1% — $1.00
CR 1800 fx_clearing:USD     USD     9900     ← $99.00 into the bridge
                                   -----
                            USD: 10000 = 100 + 9900 ✅

DR 1810 fx_clearing:USDX   USDX 99000000     ← $99.00 out of the bridge as USDX (6dp)
CR 2500 stablecoin_issued  USDX 99000000     ← we now owe 99 USDX to the world
                               --------
                            USDX: 99000000 = 99000000 ✅
```

The USD legs balance among themselves. The USDX legs balance among themselves. The `fx_clearing` pair
is what lets both be true at once — that's its entire purpose.

**T4 — reserve the float.** Move tokens from "available" to "spoken for", so a concurrent payment
can't spend the same tokens.

```
DR 1150 token_in_transit   USDX 99000000
CR 1810 fx_clearing:USDX   USDX 99000000
```

Note `1810` is now back to zero for this payment — the bridge is transient, which is exactly right.

**T5 — settled.** The chain event has been observed at confirmation depth. Only now:

```
DR 2000 merchant_payable   USDX 99000000     ← liability DOWN: debt discharged (see §4)
CR 1150 token_in_transit   USDX 99000000     ← the reserved tokens have left
```

The merchant now holds 99 USDX in their own wallet. We owe them nothing. Nothing above can be undone
by a database rollback, which is the point.

> **🔍 Review checkpoint — trace this yourself against the code.** Take a real posting from
> `LedgerService.post()` and check: does every leg carry the right `normal_side` for its account? Does
> each asset sum to zero independently? Does the `cause_id` uniquely identify the thing that caused
> it (so a redelivery collapses)? An off-by-one in `sequence` or a leg pointed at the wrong account
> code will still _balance_ and still commit — the trigger only checks the sum, not that the
> accounts are the right ones. **Balanced does not mean correct.**

---

## 8. The three flows, step by step

### 8.1 On-ramp (fiat → tokens)

| #   | Step        | What happens                                                                                                                                                                            | Has money moved? |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | **Quote**   | `POST /payment-intents` with an `Idempotency-Key`. Screening runs at the `pre_credit` gate. Pricing is snapshotted.                                                                     | ❌ No            |
| 2   | **Capture** | An outbox message calls the PSP, using the outbox `dedupe_key` as the PSP's `Idempotency-Key`. Their webhook lands in `fiat_events`. The dispatcher advances the saga and posts **T1**. | ✅ Fiat side     |
| 3   | **Reserve** | Float is reserved under a row lock → `token_in_transit`. Postings **T3** and **T4**. No float available → the saga **parks** in `awaiting_liquidity` (§3.7), it does not fail.          | ❌ Internal only |
| 4   | **Submit**  | The chain writer simulates, allocates a nonce, signs, persists, commits, then broadcasts (§9).                                                                                          | ⏳ In flight     |
| 5   | **Settle**  | The **indexer** observes `PaymentSettled` at confirmation depth, appends the transition, posts **T5**. _Only here is the merchant credited._                                            | ✅ Chain side    |
| 6   | **Serve**   | The read API queries projections only, and reports its own lag honestly via `/health`.                                                                                                  | —                |

Step 2's detail matters: the PSP's `Idempotency-Key` is the outbox row's `dedupe_key`, which is
derived from **our aggregate id**, not randomly generated. That's deliberate — if the capture call
times out and we have no idea whether the charge happened, we can poll the PSP _by that same key_ to
find out. A random key would leave us unable to ask.

### 8.2 Refund (partial reversal of an on-ramp)

Compensation order: **chain first, fiat second** (§3.5). Reclaim the tokens, then refund the card.

A payment can have **N partial refunds**, each with its own independent lifecycle. That means the
overrun guard — "total refunded must never exceed total captured" — is enforced in **three places**:

1. In application code, before starting.
2. In the database, as a constraint.
3. **On-chain**, in `PaymentProcessor.sol`: `refunded + amount <= captured`.

Three layers because the third one holds even if the first two are wrong and even if the server is
compromised (§3, and see `docs/decisions/0009`).

### 8.3 Payout (tokens → fiat)

Compensation order: **burn first, fiat second**.

The burn is **the point of no return**. Everything reversible happens before it: screening at the
`pre_payout` gate, velocity limits, float checks, transaction simulation. Once the burn confirms, the
fiat transfer must happen — and if it fails, that's an operational recovery, not a rollback.

Batching, when it exists, is inserted **after** `burn_confirmed`, never before. Burns stay per-payout
and fine-grained; only the bank-file submission batches. That way a batching bug can't destroy the
one-to-one mapping between a payout and its burn.

`docs/failure-modes.md` enumerates ~50 failure modes across all three flows, each with its trigger,
detection, designed response, and the test that proves it.

---

## 9. The chain write path

This is the hardest part of the system. Read it slowly.

### The problem

You want to send one transaction to the blockchain. Between deciding to send it and knowing it
landed, your process can crash. When it restarts, it must answer: **did that transaction go out or
not?** Getting this wrong means either paying a merchant twice or never paying them at all.

Naive approaches and why each fails:

- _"Broadcast, then record it."_ Crash between the two → the transaction is on-chain and you have no
  record. You'll do it again.
- _"Record, then broadcast."_ Crash between the two → you have a record of something that never
  happened. Do you retry? You can't tell.
- _"Use a transaction hash to check."_ You don't have the hash until you've signed it.

### The solution

```
BEGIN
  SELECT … FROM chain_accounts … FOR UPDATE      -- serializes nonce allocation
  nonce := next_nonce;  UPDATE next_nonce = nonce + 1
  INSERT INTO chain_transactions (…, intent_key) ON CONFLICT (intent_key) DO NOTHING
  policy check + sign
  INSERT INTO chain_tx_attempts (raw_tx, tx_hash, broadcast_at = NULL)
COMMIT
-- only now, outside the transaction:
eth_sendRawTransaction(raw_tx)
```

The key insight: **a signed raw transaction is deterministic bytes with a fixed hash.** Once you've
signed and committed it, you know precisely what you were going to send and what its hash would be.

So recovery after a crash is trivially simple, and identical no matter where the crash happened:

> Re-broadcast every attempt whose parent transaction isn't confirmed.

And re-broadcasting a transaction that already got mined doesn't hurt — the node replies
`already known` or `nonce too low`. **Those are success signals, not errors.** The EVM gives you
idempotency for free; you just have to be positioned to use it.

### The `FOR UPDATE` row lock on nonces

Ethereum transactions from one address carry sequential nonces: 0, 1, 2, 3. Miss one and everything
after it is stuck — nonce 5 cannot be mined until nonce 4 is.

So nonce allocation must be serialized. `SELECT ... FOR UPDATE` on the `chain_accounts` row means only
one process at a time can be allocating a nonce for that address. Slower, and correct. Two processes
grabbing nonce 4 simultaneously means one of them is permanently stuck.

### Gas escalation, and the one rule

If a transaction isn't mined because the fee was too low, you re-sign with a higher fee and the
**same nonce**, replacing it. Fine.

> **Only ever escalate `MIN(nonce)` for an account.**

If nonce 4 is stuck and 5, 6, 7 are queued behind it, bumping the fee on 7 achieves nothing. It
_cannot_ be mined while 4 is outstanding, no matter what you pay. You've spent real money for no
effect. Fix the hole at the front, and the queue drains itself.

### Simulate before signing

`eth_call` the transaction against current state first. If it would revert, you find out for free
instead of paying gas to learn it. This is one of the reversible pre-checks that must happen before
any irreversible step (§3.5).

> **🔍 Review checkpoint.** This whole path (Part 3) is unbuilt. When it lands, the test that
> matters is the crash-injection one: kill the process at 5+ different points and assert **exactly
> one mined transaction per intent**, every time. Watch specifically for (a) any code that broadcasts
> before commit, (b) any nonce allocation not under the row lock, (c) treating `already known` as an
> error, (d) escalating anything other than the minimum nonce.

---

## 10. Reorgs and replay

### What a reorg is

Blockchains occasionally discard blocks. Two miners find a block at the same height, the network
temporarily disagrees, and eventually one chain wins. Blocks on the losing branch are **orphaned** —
they and the transactions in them are no longer part of history.

If we already credited a merchant based on an event in an orphaned block, we credited them for
something that didn't happen.

### The defence, in two parts

**Confirmation depth.** Don't act on an event until N blocks have been built on top of it. Each
additional block makes a reorg exponentially less likely. N is a **risk budget** set per action type,
not a global constant (§3.2).

**Parent-hash continuity.** Every block names its parent's hash. As we index, we check that each new
block's parent hash matches the hash of the block we already recorded at that height. A mismatch
means the chain diverged, and we detect it immediately rather than inferring it later.

### What we do when we detect one

1. Mark the affected `raw_events` rows `is_orphaned = true`. (Note: **mark**, not delete. Append-only
   means append-only even here — the orphaned event is a real historical fact about what we saw.)
2. Rewind the sync cursor to before the divergence.
3. Re-index forward from there.
4. **Append a compensating saga transition** for anything already acted on.
5. **Post a reversing ledger transaction** — never edit or delete the original posting.

Steps 4 and 5 are what a payment system adds on top of a plain indexer. A read-only indexer can just
re-derive its state. A payment system may have already _paid someone_, and that needs a real,
recorded reversal.

### Replay

`ReplayService` rebuilds **projections only** — `ledger_account_balances`, saga `status`,
`blacklist_status` — from the append-only logs, with **no RPC calls**. It's pure recomputation.

And it runs as the role that has `UPDATE`/`DELETE` revoked on the log tables, so **a bug in replay
cannot corrupt history**. Worst case it produces a wrong projection, and you replay again.

This is the payoff for all the append-only discipline: "delete the projections and rebuild" is a safe,
routine operation rather than a terrifying one.

> **🔍 Review checkpoint.** The determinism test is the one that matters: snapshot the projections,
> wipe them, replay, deep-equal. If they differ, some projection depends on wall-clock time, on
> insertion order, or on something not in the logs — and that's a real bug, because it means your
> state isn't actually derivable from your logs, which is the premise the whole design rests on.

---

## 11. Reconciliation: the invariant set

Our ledger is **never authoritative about external facts.** Its job is to be a complete, balanced,
auditable record of what the chain and the PSP told us, plus our own obligations.

So every reconciliation compares **ledger vs external** — never external vs external.

| #      | The check                                                                       | How often                      |
| ------ | ------------------------------------------------------------------------------- | ------------------------------ |
| I1     | Per transaction, per asset: `Σ debits = Σ credits`                              | Every write (deferred trigger) |
| I2     | `ledger_account_balances` == recomputed `SUM(ledger_entries)`                   | 5 min + on replay              |
| I3     | `StableUSD.totalSupply()` == balance of `2500 stablecoin_issued`                | 30 s                           |
| I4     | `balanceOf(treasury)` == `token_treasury + token_in_transit`                    | 30 s                           |
| I5     | Σ tokens delivered to merchant M == Σ `merchant_payable:M` discharges           | 5 min                          |
| I6     | `fiat_events`-derived PSP position == PSP-reported balance                      | Hourly poll + daily file       |
| **I7** | **Reserve coverage: `bank_settlement + psp_receivable ≥ totalSupply()` at 1:1** | 30 s                           |
| I8     | Every `Transfer` with `from = treasury` has a `chain_transactions` row          | In-handler                     |
| I9     | `Σ refunds(intent) ≤ captured_amount(intent)`                                   | App + DB + chain               |

**I7 is the headline.** It answers "is every token in existence backed by real money we actually
hold?" That's the number a stablecoin issuer's operations team watches all day. A single stat sitting
at `1.000` that visibly dips when you inject a fault is the most legible possible demonstration that
the system is real.

**I8 is the security one.** Every token that leaves the treasury should correspond to a transaction
_we_ initiated and recorded. A `Transfer` event with no matching `chain_transactions` row means
someone moved our tokens without going through our code — i.e. the signing key is compromised.

### Drift direction carries meaning

This table is the entire reason for having two logs. The _direction_ of a discrepancy tells you
whether it's boring or an emergency:

| Drift                 | Benign cause                                              | Serious cause                   | How to tell them apart                                                         |
| --------------------- | --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| Chain ahead of ledger | Indexer lag                                               | **Unauthorized key use**        | I8 — is there a `chain_transactions` row? If not: freeze and page              |
| Ledger ahead of chain | Should be impossible (pending sits in `token_in_transit`) | Premature credit or handler bug | Run replay. Resolves → projection bug. Doesn't → a real loss                   |
| PSP ahead of us       | Dropped webhook                                           | —                               | The poller recovers it. Alert only if the recovery _rate_ rises                |
| We ahead of PSP       | —                                                         | **Forged webhook**              | No benign explanation exists. Security incident, not a reconciliation incident |
| Coverage < 1          | Fee timing                                                | We minted without backing       | Halt minting, page                                                             |

### Reconciliation never writes

In audit mode, reconcilers do **zero writes**. Auto-healing is a separately-invoked action, with its
own ledger transactions and a recorded operator id.

> A system that silently self-heals a discrepancy has destroyed the evidence of the bug that caused
> it. You'll never find the root cause, and it will happen again — bigger.

---

## 12. How failures are handled: the four categories

Every failure in this system resolves to exactly one of four responses. Knowing which is which is
most of operating it.

| Response        | When                                                                   | What it looks like                                                    |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Crash**       | Bad config, duplicate handler registration, chain fingerprint mismatch | Process exits at boot. Loud, cheap, unambiguous                       |
| **Dead-letter** | One handler threw on one event                                         | Row in `indexer_failures`, retry with backoff, indexer keeps going    |
| **Park**        | Resource exhausted — no gas, no float, screening unavailable           | Named state (`awaiting_liquidity`), resumes when the resource returns |
| **Defer**       | Event arrived too early but is legal later                             | Re-queued with backoff; alert after N deferrals                       |

Plus one classification layer on top, in the saga transition classifier. When a transition's
`from_status` doesn't match the saga's current state, it is never a silent no-op and never a bare
error — it is classified:

| Classification | Meaning                                | Response                 |
| -------------- | -------------------------------------- | ------------------------ |
| `IGNORE`       | Already past this point — a duplicate  | No-op, but count it      |
| `DEFER`        | Arrived too early; will be legal later | Re-queue with backoff    |
| `ILLEGAL`      | Can never be legal from this state     | Dead-letter **and page** |

That tri-state is the out-of-order defence. The `ILLEGAL` case is the one that pages a human, because
it means reality contradicted the model — e.g. a capture arriving after we already told the customer
their payment was declined (`docs/failure-modes.md` A4). That's not a retry situation; someone needs
to look at it.

> **🔍 Review checkpoint.** Any `catch` block that swallows an error, or any state transition that
> silently no-ops without incrementing a counter, is a bug in this design. The three classifications
> must be exhaustive, and each must be observable.

---

## 13. What is actually built today

**As of 2026-09-06: 16 of 76 blocks. Phase 0 complete, Part 1 (the ledger) at 7 of 9.**

[`progress.md`](progress.md) owns this count — if the two disagree, it wins. The 2026-09-06 audit
and the fixes that followed are recorded in
[`reviews/2026-09-06-audit-and-fixes.md`](reviews/2026-09-06-audit-and-fixes.md).

Everything in §§1–12 is _designed_. Only a fraction is _code_. When reviewing, be clear which you're
looking at.

### Built and tested

| Thing                                                | Where                                                    |
| ---------------------------------------------------- | -------------------------------------------------------- |
| App boots, `/health` does a real `SELECT 1`          | `apps/indexer/src/api/health.controller.ts`              |
| Env validated with zod, crashes at boot              | `apps/indexer/src/config/env.schema.ts`                  |
| Integer money — `add`/`sub`/`splitFee`/`convert`     | `apps/indexer/src/ledger/money.ts` (property tests pass) |
| `assets` + chart of accounts (3 assets, 16 accounts) | `migrations/1754006400000-AssetsAndChartOfAccounts.ts`   |
| Ledger tables + 5 TypeORM entities                   | `migrations/1754006400001-CreateLedgerTables.ts`         |
| **Deferred balance trigger**                         | `migrations/1754006400002-LedgerBalanceTrigger.ts`       |
| Immutability trigger + `ledgerline_app` role split   | `migrations/1754006400003-LedgerImmutability.ts`         |
| **Non-negative check**                               | `migrations/1754006400004-LedgerNonNegativeCheck.ts`     |
| `LedgerService.post()` — the single writer           | `apps/indexer/src/ledger/ledger.service.ts`              |
| `AccountRegistryService` — code → UUID               | `apps/indexer/src/ledger/account-registry.service.ts`    |
| **Account-row lock** on the non-negative check       | `migrations/1754006400007-LedgerNonNegativeLock.ts`      |
| Entry asset bound to account asset (composite FK)    | same migration                                           |
| `/metrics` + the first ledger instrument             | `apps/indexer/src/observability/`                        |
| Integration tests in CI, throwaway DB per run        | `.github/workflows/ci.yml`, `test/global-setup.ts`       |
| `pnpm docs:check` — docs vs schema                   | `scripts/docs-check.mjs`                                 |

### Not built yet

Balances projection (1.7) · trial-balance property test (1.8) · **all contracts** (Part 2) · **the
entire chain write path** (Part 3) · the indexer's ingest loop (Part 4 — scaffolding exists from the
inherited design, unwired) · **the fiat rail and mock PSP** (Part 5) · the on-ramp saga (Part 6) ·
reconcilers and metrics (Part 7) · refunds, payouts, compliance, everything in Parts 8–13.

So: **§§4–7 you can review against real code. §§8–12 you are reviewing a design document.** Both are
worth doing, but they're different activities.

---

## 14. Review checklist — where bugs hide

Consolidated from the checkpoints above, plus the specific open questions I found reading the current
code.

### Open questions in the code as it stands

Eight were raised here on 2026-09-06. Six are closed; the two that remain are listed with the reason.
Full detail, including what each fix changed, is in
[`reviews/2026-09-06-audit-and-fixes.md`](reviews/2026-09-06-audit-and-fixes.md).

**Closed.**

1. ~~`post()` opens its own transaction, so a saga transition and its posting commit separately.~~
   `post()` now takes an optional `QueryRunner` so a caller can join its own transaction.
2. ~~`createMerchantAccount` has a check-then-insert race.~~ Now `ON CONFLICT DO NOTHING` plus a
   re-select, so the loser of a race gets the winner's row rather than a unique violation.
3. ~~The non-negative check has no asset filter.~~ It filters by `asset_code`, and a composite
   foreign key now enforces the "accounts are per-asset" assumption it used to rely on. The same
   migration also fixed a **worse** problem the checklist missed: the check was unlocked, so two
   concurrent commits could each pass and drive an account negative — write-skew, and precisely
   Part 1's exit criterion. See [ADR-0017](decisions/0017-non-negative-enforcement.md).
4. ~~`convert()`'s residual unit.~~ It is now an amount in the **source** asset, so it is postable
   in either scale direction. See [ADR-0015](decisions/0015-rounding-residual-unit.md).
5. ~~`ledger_transactions.kind` rejects the vocabulary this document uses.~~ The schema moved to the
   dotted vocabulary, and `pnpm docs:check` now fails the build if they diverge again. See
   [ADR-0016](decisions/0016-transaction-kind-vocabulary.md).
6. ~~`posted_at` is documented as set by `post()` but never was.~~ Threaded through
   `PostingRequest`, because replay determinism is a Part 4 exit criterion.

**Still open.**

7. **The `alreadyPosted` path never verifies the entries match** (`ledger.service.ts`). Posting the
   same `(kind, cause_type, cause_id)` with **different legs** returns `alreadyPosted: true` and
   silently discards the new legs. Correct for a genuine redelivery, dangerous for a bug. The
   `idempotency_keys` design (§6.2) stores a `request_hash` for exactly this case and returns `422`.
   Deferred rather than fixed: the ledger has no second writer yet, and the right shape for the
   fingerprint depends on Block 6.2's idempotency work. **Resolve it with 6.2, not later.**
8. **The payout state machine credits `token_in_transit` twice** ([`build-plan.md:139`](build-plan.md)
   and `:141`) with no debit on that path. `1150` is seeded `allows_negative = false`, so as literally
   written the non-negative trigger would now reject it at COMMIT — and after the lock fix, reject it
   reliably rather than occasionally. These are one-line shorthand in a state diagram rather than real
   postings, so they may just be abbreviated, but **resolve it before Part 9**. Related: why is
   `merchant_payable` debited on the off-ramp at all, when §7's T5 already discharged it at on-ramp
   settlement?

**One more, found by running the tests rather than reading them:** the balance trigger had to become
`SECURITY DEFINER`, because `SELECT ... FOR UPDATE` needs `UPDATE` privilege and `ledgerline_app`
deliberately has none on `ledger_accounts`. That is a privilege boundary now — keep the function tiny
and treat any edit to it as a security review.

### Questions to carry into every future review

- **Does this credit anyone based on a hint?** A receipt, a `200`, an optimistic write. If yes, it's
  wrong unless it's a revert driving compensation.
- **What happens if this message arrives twice?** Trace it to a unique constraint. If the answer is
  "the application checks first", that's a race, not idempotency.
- **What happens if this message arrives out of order?** Which of `IGNORE`/`DEFER`/`ILLEGAL` does it
  get? If the answer is "it throws", that's a bug.
- **Is this posting _balanced_ or is it _correct_?** The trigger only proves the first. A leg pointed
  at the wrong account still commits.
- **Is this config value read live, or snapshotted?** Live reads inside an in-flight saga are bugs.
- **If this step fails halfway, what's left behind — an SLA problem or a solvency problem?** If the
  latter, the ordering is wrong.
- **Is this a projection or a log?** Projections may be wiped and rebuilt. Logs may not be touched.
- **Does this metric use a high-cardinality label?** Merchant id, address, tx hash, payment id — all
  forbidden.
- **Does this failure mode have a test?** `docs/failure-modes.md` says an entry without a test is a
  claim, not a design.

---

## Where to go next

| Document                                             | Answers                                             |
| ---------------------------------------------------- | --------------------------------------------------- |
| [`architecture.md`](architecture.md)                 | The same content, dense and precise — the reference |
| [`failure-modes.md`](failure-modes.md)               | ~50 failure modes, each with its test               |
| [`decisions/`](decisions/)                           | 14 ADRs — alternatives considered and why each lost |
| [`learning-path.md`](learning-path.md)               | The concepts, in 45 teaching blocks                 |
| [`implementation-guide.md`](implementation-guide.md) | What to type, in which file, in what order          |
| [`build-plan.md`](build-plan.md)                     | The phases and their exit criteria                  |
| [`progress.md`](progress.md)                         | What's actually done                                |
| [`conventions.md`](conventions.md)                   | The binding coding rules                            |
| [`observability.md`](observability.md)               | Metrics, spans, the permitted label set             |
| [`runbook.md`](runbook.md)                           | What to do when an alert fires                      |
