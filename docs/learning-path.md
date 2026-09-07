# Ledgerline — Learning Path

> [`build-plan.md`](build-plan.md) says **what** to build and in what order.
> This document says **why each piece exists and how to think about it.**

Read a block, understand the idea, then write the code. Every block is small enough to finish in
one sitting and leaves the repo working.

**How each block is laid out:**

- **The problem** — what goes wrong without this piece
- **The idea** — the concept you're learning
- **Build** — what to actually write
- **Done when** — how you know it works
- **Can you answer this?** — the question an interviewer will ask about this piece

If you can't answer the last one, you built the code but missed the idea. Go back.

---

# Part 0 — The mental model

**Read this before writing any code.** Everything else is a consequence of it.

## 0.1 What the system does, in one paragraph

A customer pays $100 with a card. We take the fiat, and send the merchant $99 worth of a stablecoin
we issue (we keep $1). Later, the merchant can cash out: they give the tokens back, we send them
real money. That's it. Three flows: **money in**, **money back** (refund), **money out** (payout).

## 0.2 Why this is hard

Not the token transfer — that's a solved problem. The hard part is this:

> **There are two systems that both hold the truth, and we control neither of them.**

The card processor knows whether the card actually charged. The blockchain knows whether the tokens
actually moved. **Neither can undo the other.** If the card charges and the chain transaction fails,
no amount of clever code makes that atomic. There is no "undo" button that spans both.

Every design decision in this project exists to deal with that one fact.

## 0.3 The five ideas everything derives from

**1. Write down what happened, forever. Calculate everything else.**

Never store "merchant balance = $500." Store the list of things that happened and add them up.
Why: if you find a bug in how you calculate balances, you fix the code and recalculate. If you'd
stored the balance, the wrong number is all you have.

**2. Assume every message arrives twice, out of order, or not at all.**

Card processors retry webhooks. Networks drop packets. Your own server crashes mid-operation. Code
that assumes "this will be delivered exactly once, in order" is code that will corrupt money.

**3. Only believe something when the system that owns it confirms it.**

Your server thinking "I sent the transaction" is not the same as the chain saying "it's in a block,
and that block is buried under several more." Believing the first one is how exchanges lose money.

**4. Do the thing you can't undo _first_, while you still control both sides.**

Refunding? Take the tokens back **first**, then refund the card. If you refund the card first and
the token clawback fails, the customer has their money and the merchant has the tokens. You just
lost real money with no recovery path. Reverse the order and the worst case is "the refund is
slow" — annoying, not fatal.

**5. When you can't undo something, say so out loud.**

Some failures have no code fix. Tokens delivered to a merchant's own wallet cannot be recalled. The
honest design records a **debt** and flags a human. Pretending otherwise is worse than admitting it.

## 0.4 The map

```
     CARD PROCESSOR                              BLOCKCHAIN
     (we don't control it)                  (we don't control it)
            │                                       │
            │ webhooks                       events │
            ▼                                       ▼
     ┌─────────────┐                         ┌─────────────┐
     │ fiat_events │                         │ raw_events  │      ← two permanent lists
     └──────┬──────┘                         └──────┬──────┘        of what happened
            │                                       │
            └──────────────┬────────────────────────┘
                           ▼
                   ┌───────────────┐
                   │  THE SAGAS    │   ← the "boss": decides what happens next
                   │ on-ramp       │
                   │ refund        │
                   │ payout        │
                   └───────┬───────┘
                           ▼
                   ┌───────────────┐
                   │  THE LEDGER   │   ← the accounting record. Balanced. Immutable.
                   └───────────────┘
                           │
                           ▼
                    balances, API, dashboards  ← all calculated, all disposable
```

**Can you answer this?** _"Why can't you just wrap the card charge and the chain transaction in a
database transaction?"_

---

# Part 1 — The ledger

_Phase 1. This is the foundation. Nothing else works if this is wrong._

## Block 1.1 — Money as whole numbers

**The problem.** `0.1 + 0.2 = 0.30000000000000004`. In a payment system that's not a curiosity,
it's a lost cent that compounds into a reconciliation you can never close.

**The idea.** Never store money as a decimal. Store the **smallest unit as a whole number**.

```
$100.00  →  10000       (cents)
100 USDX →  100000000   (USDX has 6 decimal places)
```

The scale belongs to the **currency**, not the number. That's what the `assets` table is for.

Then one hard rule: **you may only add together amounts of the same currency.** `usdAmount +
usdxAmount` is meaningless — like adding 5 metres to 3 kilograms.

**Build.**

- `ledger/money.ts` — amounts are `string` in TypeScript (because JS numbers can't hold big
  integers safely), converted to `bigint` only inside the helper functions
- `splitFee(amount, bps)` → `{ fee, net }` where `fee = floor(amount × bps / 10000)` and
  `net = amount − fee`. Never round both sides — that's how you invent or destroy a cent
- `convert(amountMinor, fromDecimals, toDecimals, rateNum, rateDen)` → `{ amount, residual }`

**The subtle bit — and it is subtler than it first looks.** Scaling $99.00 (2 decimals) up to USDX
(6 decimals) is exact _at a 1:1 rate_. Change the rate to 1/3 and it is not, in either direction:
some fraction cannot be carried. That leftover is the **residual**, you must return it rather than
drop it, and you record it in `3900 rounding_residual`. Dropped dust is the single most common reason
a ledger stops balancing.

**The part that is easy to get wrong, and did get wrong here.** It is not enough to return _a_
leftover — it has to be a leftover **in a named asset**, or you cannot post it. `residual` is an
amount in the **source** asset's minor units: the part of the input too small to buy another whole
unit of the target. The original implementation returned the raw remainder of its internal division,
whose unit silently changed with the direction of the scale change — source units one way, a fraction
of a _target_ unit the other. At a 1:1 rate those coincide, which is exactly why two passing tests
did not catch it for the life of this block. See
[ADR-0015](decisions/0015-rounding-residual-unit.md).

**Done when.** Property tests pass over thousands of random inputs: `fee + net === amount` exactly,
and `consumed + residual === amountMinor` with the residual never large enough to buy another unit
of the target. Vary the _rate_ as well as the amount — a test that only ever uses 1:1 proves much
less than it appears to.

**Can you answer this?** _"Why `numeric(38,0)` in the database rather than `bigint`?"_
(Hint: a token with 18 decimals.)

---

## Block 1.2 — Learn double-entry (no code)

**Don't skip this.** Write no code for this block. Understand the idea first, because the next four
blocks are meaningless without it.

**The problem.** A single balance column can be wrong and nothing tells you. If `merchant_balance`
says $500 and it should say $400, the database is perfectly happy.

**The idea, in one sentence:** _money never appears or disappears — it only moves from one place to
another._ So every entry is recorded **twice**: where it came from, and where it went. The two must
be equal.

The vocabulary is 500 years old and slightly confusing, so here it is plainly:

- **Debit** = the left column
- **Credit** = the right column
- For any single transaction: **left column total must equal right column total**

That's the whole rule. If they don't match, you made an error — and **the database refuses the
write.** That's the superpower. A single-balance system can't detect its own mistakes; this one
can't _avoid_ detecting them.

**Worked example — a $100 payment, $1 fee.**

```
Money arrives from the card processor:
  DEBIT   psp_receivable     10000     ← we're now owed $100 by the processor
  CREDIT  unsettled_capture  10000     ← we owe $100 to... someone (TBD)
                             ─────
                    both sides: 10000  ✓ balanced

We take our fee and figure out who it belongs to:
  DEBIT   unsettled_capture  10000     ← clear the "TBD"
  CREDIT  fee_revenue          100     ← $1 is ours
  CREDIT  merchant_payable    9900     ← $99 is the merchant's
                                       ─────
                     left 10000 = right 100 + 9900  ✓ balanced
```

Read those until they click. Every operation in this project is one of these.

**The one confusing part.** "Debit" doesn't mean decrease and "credit" doesn't mean increase — it
depends on the account type. Don't fight it, just internalise these four:

|                                       | Debit     | Credit    |
| ------------------------------------- | --------- | --------- |
| Things we **own** (cash, tokens)      | increases | decreases |
| Things we **owe** (merchant balances) | decreases | increases |
| **Income** (fees)                     | —         | increases |
| **Costs** (gas, losses)               | increases | —         |

**Can you answer this?** _"Why is crediting a merchant recorded as a liability rather than an
asset?"_ (Because their money isn't ours — we're holding it for them, so we owe it.)

---

## Block 1.3 — The four ledger tables

**The idea.** Four tables, each with exactly one job:

| Table                     | Job                                  | Analogy                   |
| ------------------------- | ------------------------------------ | ------------------------- |
| `ledger_accounts`         | The list of buckets money can sit in | The chart of accounts     |
| `ledger_transactions`     | One business event                   | "A $100 payment happened" |
| `ledger_entries`          | The individual debit/credit lines    | The rows of that entry    |
| `ledger_account_balances` | Current totals, **calculated**       | A cached sum              |

One `ledger_transaction` has **two or more** `ledger_entries`. The entries must balance.

**Build.** A migration creating all four. `ledger_accounts` already exists from Phase 0 — you're
adding the other three.

Key columns on `ledger_entries`: `transaction_id`, `account_id`, `direction` (`'debit'|'credit'`),
`asset_code`, `amount_minor`, `sequence`.

**The one to think about:** `ledger_transactions` has `UNIQUE(kind, cause_type, cause_id)`.

That means: _"the posting caused by webhook `evt_123` may exist only once."_ If the same webhook
arrives twice and you try to post twice, the **database rejects the second one**. You don't need
"have I already done this?" logic — you literally cannot do it twice.

**Done when.** Migration runs up, down, and up again cleanly.

**Can you answer this?** _"Why is `ledger_account_balances` a separate table rather than a `SUM()`
query?"_ (Two reasons — one is speed, the other you'll discover in Block 1.7.)

---

## Block 1.4 — Make the database refuse unbalanced entries

**This is the most important block in Part 1.**

**The problem.** You could check "do the debits equal the credits?" in your TypeScript. But that
check won't run when someone writes a migration script, or fixes something by hand in `psql` at 3am,
or when a future refactor introduces a second code path.

**The idea.** Put the check **in the database**. Then it's not a convention, it's physics.

There's a catch, and it's the interesting part. Entries are inserted one row at a time:

```
INSERT entry 1 (debit 10000)   ← at this instant, debits ≠ credits!
INSERT entry 2 (credit 10000)  ← now it balances
COMMIT
```

A normal trigger fires on the _first_ insert and rejects a perfectly valid transaction. You need a
trigger that waits until `COMMIT` and _then_ checks. That's a **deferred constraint trigger**:

```sql
CREATE CONSTRAINT TRIGGER ledger_entries_balance_check
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED          -- ← "check at COMMIT, not now"
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balances();
```

And the check groups by currency, because $100 and 100 USDX balancing against each other is
nonsense:

```sql
SELECT asset_code,
       SUM(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END) AS residual
FROM ledger_entries WHERE transaction_id = <the one being committed>
GROUP BY asset_code
HAVING residual <> 0        -- any row here → raise an exception, kill the COMMIT
```

**Build.** The trigger function and the trigger.

**Done when.** A test inserts a deliberately unbalanced pair and the `COMMIT` **throws**. That
failing test is the proof your ledger can't lie.

**Can you answer this?** _"Why deferred? What breaks if it isn't?"_

---

## Block 1.5 — Make entries permanent

**The problem.** If a row can be edited, your permanent record isn't permanent, and "replay from
history" rebuilds whatever someone last edited.

**The idea.** Accountants solved this centuries ago: **you never erase a mistake.** You write a new,
opposite entry that cancels it, and both stay visible forever.

Wrong entry: `DEBIT cash 100`
The fix: `CREDIT cash 100` (a new row, linked to the first via `reverses_id`)

Net effect: zero. But the history shows _both_ the error and the correction — which is exactly what
you want when investigating.

**Build.**

- A trigger that raises an exception on `UPDATE` or `DELETE` of `ledger_entries`
- Belt and braces: `REVOKE UPDATE, DELETE ON ledger_entries FROM <app_role>`
- A `reverses_id` column pointing at the transaction being cancelled

**Done when.** A three-line test proves `UPDATE ledger_entries SET amount_minor = 1` throws.

**Can you answer this?** _"A bug credited a merchant twice. How do you fix it?"_ (Not `DELETE`.)

---

## Block 1.6 — `LedgerService.post()`

**The idea.** **Exactly one function in the entire codebase writes to the ledger.** Not two. One.

Everything else calls it. It's the narrow gate everything passes through, which means every rule you
want enforced has exactly one place to live.

```ts
await ledger.post({
  kind: "onramp.capture",
  cause: { type: "fiat_event", id: "evt_123" }, // makes it idempotent
  memo: "Card captured for intent abc",
  entries: [
    { account: "1000", direction: "debit", asset: "USD", amount: "10000" },
    { account: "2100", direction: "credit", asset: "USD", amount: "10000" },
  ],
});
```

**The design detail worth noticing.** Validate the balance **in TypeScript first**, then let the
trigger be the backstop. Why both? Because the TypeScript check gives you a good error message
pointing at the line of code, while the trigger catches everything the TypeScript path missed. Two
layers, different failure modes.

**Build.** The service, in one transaction: insert header → insert entries → update balances.

**Done when.** A test posts a balanced transaction and reads the balances back correctly.

**Can you answer this?** _"Why validate in both the app and the database? Isn't that duplication?"_

---

## Block 1.7 — The balances projection

**The idea.** `ledger_account_balances` is a **cache**. It holds nothing you couldn't recompute by
summing `ledger_entries`. You could delete the whole table and rebuild it.

So why does it exist? The obvious answer is speed. The **real** answer is this:

```sql
UPDATE ledger_account_balances SET balance_minor = ... WHERE account_id = $1;
```

That `UPDATE` takes a **row lock**. Which means if two payouts try to spend the same treasury
balance at the same instant, Postgres forces them into a queue. One sees the balance _after_ the
other has taken its share.

Without that lock, both would read "$500 available," both approve, and you've spent $1000 you don't
have. **The cache is also your concurrency control.** That's the second reason from Block 1.3.

**Build.** Update balances inside the same transaction as the entries, via a row-locking `UPDATE`.

**Done when.** A test fires 20 concurrent payouts against a balance that only covers 10, and
**exactly 10 succeed**. Not 11. Not 9.

**Can you answer this?** _"Two requests spend the same balance simultaneously. What stops the
overdraft?"_

---

## Block 1.8 — The test that proves it all

**The idea.** A **property test**: instead of writing 50 specific test cases, describe a rule that
must _always_ hold, then let the machine generate thousands of random scenarios trying to break it.

The rule: **after any sequence of valid operations, every currency's debits equal its credits.**

```
for 10,000 random sequences of (capture, settle, refund, payout, chargeback):
    assert: for every currency, SUM(debits) === SUM(credits)
    assert: no account that shouldn't go negative went negative
```

Use `fast-check`. When it finds a failure it **shrinks** it — it hands you the smallest sequence
that reproduces the bug, not the 400-step one it stumbled on.

**Done when.** It passes. Now put it in CI and never remove it.

> **Why this matters more than the code.** A ledger whose balances _should_ balance is worse than no
> ledger, because it makes a promise it doesn't keep. This test is what turns "should" into "does."

**Can you answer this?** _"How do you know your ledger is correct?"_ — this test is the answer.

---

**Part 1 complete.** You now have something real: a ledger that is mathematically incapable of
losing money. No blockchain involved yet. That's deliberate — this piece is worth understanding on
its own.

---

# Part 2 — The contracts

_Phase 2. Smaller than Part 1. Two contracts, one big idea._

## Block 2.1 — `StableUSD`, and why 6 decimals

**The idea.** You're building a token modelled on how real USDC works. Real USDC has **6** decimal
places, not 18. Match it — using 18 would mean every amount is wrong by a factor of a trillion the
day you point this at real USDC.

**Build.** ERC-20 with `decimals() = 6`. Use OpenZeppelin, don't hand-roll it.

**Done when.** `forge test` passes basic transfer tests, and one test asserts `decimals() == 6`.
That test looks trivial. It catches a refactor that would silently destroy every amount in the
system.

---

## Block 2.2 — Minter allowance

**The problem.** If any key can mint unlimited tokens, that key compromise is unlimited loss.

**The idea.** A **budget**. The admin grants a minter permission to create _at most_ N tokens. Mint
more than the allowance and the transaction reverts.

**The design decision worth understanding:** when the allowance runs low, **do not top it up
automatically.** It's tempting — the alert is annoying. But an automatic top-up means the limit is
no longer a limit, it's just a delay. Raising it should be a deliberate act with a reason attached.

**Build.** `configureMinter`, `removeMinter`, `mint` checking the allowance, custom errors.

**Can you answer this?** _"Why not auto-raise the minter allowance when it runs low?"_

---

## Block 2.3 — Blacklist and pause

**The idea.** Real stablecoin issuers can freeze addresses and halt the token. That's not optional —
it's a regulatory requirement. It must be enforced **at the token**, not at your API, because your
API can be bypassed and the token cannot.

**Build.** `blacklist` / `unBlacklist` / `isBlacklisted`, `pause` / `unpause`, both gated by roles.
Blocked transfers revert with `AccountBlacklisted` / `TokenPaused` — named errors, so your backend
can read the reason and decide what to do.

**Can you answer this?** _"Why enforce the blacklist on-chain rather than in your backend?"_

---

## Block 2.4 — `PaymentProcessor.settle` — the safety net

**This is the most important line of Solidity in the project.**

**The problem.** Your server crashes right after broadcasting a settlement transaction. On restart,
it doesn't know whether that transaction landed. Safest thing is to retry. But if the first one _did_
land, retrying pays the merchant **twice**.

**The idea.** Make the double payment **impossible at the contract level**:

```solidity
if (payments[paymentId].exists) revert PaymentAlreadySettled(paymentId);
payments[paymentId] = Payment({ ... });
```

Now retrying is completely safe. The second attempt reverts. **You can be reckless about retries
because the contract cannot be fooled.**

Yes, you'll also have idempotency checks in your backend. Those are the first line of defence. This
is the one that holds when the first line has a bug — and unlike your backend, it can't be bypassed
by a compromised server.

**Build.** `settle`, storing each payment by id, reverting on a duplicate.

**Can you answer this?** _"You already have idempotency in the database. Why do it on-chain too?"_

---

## Block 2.5 — The refund cap

Same idea, different failure. A $100 payment must never be refunded $150 in total, no matter how
many partial refunds are issued or what bug your backend has:

```solidity
if (p.refunded + amount > p.amount) revert RefundExceedsCapture(...);
```

**Can you answer this?** _"Where do you enforce that refunds can't exceed the original payment?"_
(Three places, and they fail differently: app bug / race condition / compromised server.)

---

## Block 2.6 — Invariant tests

**The idea.** Normal tests check "I did X, did Y happen?" **Invariant tests** check "no matter what
sequence of things happens, is this statement still true?" Foundry generates thousands of random
call sequences and checks after every one.

The ones to write:

| Invariant                                | What it catches                 |
| ---------------------------------------- | ------------------------------- |
| `sum of all balances == totalSupply()`   | Tokens invented or destroyed    |
| `totalSupply() == minted − burned`       | Broken accounting               |
| `token.balanceOf(paymentProcessor) == 0` | **Funds stuck in the contract** |
| `refunded <= amount`, always             | Refund overrun                  |

That third one is one line and it eliminates an entire class of bug. The processor is a **pipe**, not
a **bucket** — money passes through, never rests there. If it ever holds a balance, something is
stuck, and this catches it instantly.

**Can you answer this?** _"What's the difference between a unit test and an invariant test?"_

---

## Block 2.7 — Deploy script

`Deploy.s.sol` deploys both contracts, grants roles, sets the initial minter allowance, mints the
starting treasury, and writes the addresses to a JSON file your backend reads.

**Done when.** `make chain` gives you a running local chain with both contracts live.

---

# Part 3 — Writing to the chain

_Phase 3. **The hardest part of the project.** Take your time here._

## Block 3.1 — Understand the problem first (no code)

**Read this before writing anything.**

Sending a blockchain transaction has a property that makes it genuinely difficult:

> **The instant you broadcast, it's out of your hands — and you might not find out what happened.**

Your process can crash between "broadcast" and "write down that I broadcast." Now on restart:

- Did it land? **You don't know.**
- Which transaction was it? **You may not even know that** — if you generated the nonce in memory,
  it's gone.
- Retry? Might double-pay. Don't retry? Might never pay.

**The second problem: nonces.** Every transaction from an address has a sequence number, and the
chain processes them **strictly in order**. If transaction #5 gets stuck, then #6, #7 and #8 **cannot
be mined** — they're queued behind it. One stuck transaction halts everything from that address.

Sit with both of those. The next six blocks are the answer.

**Can you answer this?** _"Your process dies right after broadcasting. What do you do on restart?"_

---

## Block 3.2 — Nonces in the database, under a lock

**The idea.** Three tempting approaches, all broken:

| Approach                                        | Why it breaks                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Keep a counter in memory                        | Lost on restart. You get a gap (everything stalls) or a duplicate (a transaction silently replaces another)                        |
| Ask the node (`getTransactionCount('pending')`) | Two workers ask simultaneously, both get `5`, both use `5`. Also, `pending` is that node's _opinion_ and differs between providers |
| Use Redis / a lock service                      | Another container, another network partition to reason about, for something Postgres already does perfectly                        |

**What works:** a table with one row per signing address, holding the next nonce. Take it with
`SELECT ... FOR UPDATE`, which makes Postgres queue concurrent requests. One at a time, guaranteed,
survives restarts.

**Build.** `chain_accounts` (address, role, `next_nonce`, `is_frozen`) and the locked allocation.

**Can you answer this?** _"Why not just ask the node for the nonce?"_

---

## Block 3.3 — `SignerPort`

**The idea.** Signing is behind an interface. Two implementations:

- `LocalDevSigner` — a private key from an env var. **Refuses to start** unless it's a dev
  environment on chain 31337. That guard is the entire point.
- `KmsSigner` — the shape a real system uses (keys in hardware, never exportable)

But the genuinely interesting part isn't where the key lives. It's **`SigningPolicyService`**, which
runs before every signature and asks: is this transaction allowed?

- Under the per-transaction value cap?
- Under the rolling hourly total?
- Is the destination on the allowlist?
- **Is this key even allowed to call this function?** (the payout key may call `settle` — it may
  _not_ call `blacklist` or `configureMinter`)
- Right chain id?
- Is the account frozen?

Every decision — allow _and_ deny — gets logged to `signing_requests`.

> **Say this out loud, because it's the real lesson:** custody is 20% "where are the bytes" and 80%
> "what is this key permitted to do." The demo can't do the first part honestly. It can do the
> second part completely.

**Can you answer this?** _"Your demo uses publicly-known test keys. What did you actually build?"_

---

## Block 3.4 — Sign → save → commit → **then** broadcast

**This block is the answer to Block 3.1. It's the single most important ordering decision in the
project.**

**The wrong order** (what most people write):

```
broadcast the transaction
  ← CRASH HERE and you've lost a transaction you cannot identify
save what you did
```

**The right order:**

```
BEGIN
  lock the account row, take the next nonce
  build and SIGN the transaction        ← produces exact bytes with a fixed hash
  SAVE the signed bytes and the hash
COMMIT                                  ← now it's durable
                                        ← CRASH HERE and you've lost nothing
broadcast
```

**Why this works, and it's genuinely elegant:** a signed transaction is **fixed bytes with a fixed
hash**. It cannot change. So after a crash — at _any_ point — recovery is one simple rule:

> _Re-broadcast every saved transaction that isn't confirmed yet._

And here's the part that makes it click: if it already landed, the network replies **`already known`**
or **`nonce too low`**. Those look like errors. **They're success messages.** They mean "yes, we have
it." You treat them as confirmation, not failure.

You get exactly-once behaviour for free, from the blockchain itself.

**Build.** `chain_transactions` (one per logical transaction, `UNIQUE(intent_key)`) and
`chain_tx_attempts` (one row per broadcast, storing the signed bytes).

**Done when.** You can kill the process at five different points and always end with exactly one
mined transaction.

**Can you answer this?** _"Why sign and save before broadcasting?"_ — if you can explain this
clearly, you understand the hardest part of the project.

---

## Block 3.5 — Simulate first

**The idea.** Before spending a nonce, ask the chain: _"if I ran this right now, would it work?"_
That's `eth_call` — a dry run that costs nothing and changes nothing.

If it would fail, you learn **why** (a named error like `AccountBlacklisted`), you **don't burn a
nonce**, and you move the payment into a state that names the actual problem instead of "failed."

**Honest limitation:** simulation is a snapshot. Things can change between simulating and mining. It
reduces failures; it doesn't eliminate them. You still need Block 3.6.

**Can you answer this?** _"Why simulate if it can still fail afterwards?"_

---

## Block 3.6 — The watcher, and the one exception

**The idea.** Something has to poll for receipts. But here's the rule:

> **The watcher never credits anybody.**

Confirmations come from your _indexer_ seeing the event (Part 4), not from a receipt. A receipt says
"it's in a block." An event seen at depth says "it's in a block that's buried and isn't going away."

**The exception, and it's important.** If a transaction **reverted**, it emitted _no events at all_.
The indexer will never see anything. It'll just sit there forever. So the watcher _does_ handle
reverts — but notice it only ever pushes things toward **undoing**, never toward **paying**.

Reading _why_ it reverted takes a trick: re-run the simulation at the block _before_ it was mined,
and viem decodes the custom error.

**Can you answer this?** _"Why is a receipt not good enough to credit a merchant?"_

---

## Block 3.7 — Stuck transactions, and the rule people get wrong

**The problem.** Gas prices rise, your transaction sits unmined, and every later transaction from
that address is stuck behind it.

**The fix.** Re-sign the **same nonce** with a higher fee. Same slot, more attractive. Both versions
exist; whichever gets mined wins.

**The rule almost everyone gets wrong:**

> **Only ever bump the OLDEST stuck transaction.**

If #5 is stuck, bumping #7 does nothing — #7 physically cannot be mined until #5 is. You've spent
extra gas for zero effect. Fix the hole; never jump over it.

**When bumping stops working** (you've hit your fee ceiling): send a **cancel** — same nonce, empty
transaction to yourself, aggressive fee. It takes the slot, unblocking everything behind it, and the
original payment moves to a compensating path.

**Note what the customer sees while this happens:** `processing`. Not `failed`. Because you genuinely
don't know yet, and saying `failed` when it might still land is how you produce a double payment.

**Can you answer this?** _"Transaction #5 is stuck and #6, #7 are queued behind it. What do you do?"_

---

## Block 3.8 — Prove it with crashes

**The idea.** Define named points in the submitter:

```ts
enum CrashPoint {
  AfterNonce,
  AfterSign,
  AfterPersist,
  BeforeBroadcast,
  AfterBroadcast,
  AfterReceipt,
}
```

For each one: kill the process there, restart, assert **exactly one transaction was mined**.

> This is the highest-value test in the repo. It's also the answer to _"how do you know your system
> is crash-safe?"_ — you don't argue, you point at the test.

---

# Part 4 — Reading the chain

_Phase 4. If you've built an indexer before, most of this is familiar. Two things are new._

## Block 4.1 — `raw_events`, and a real bug

**The idea.** A permanent list of every event seen on-chain, with `ON CONFLICT DO NOTHING` so
re-reading the same block is harmless.

**The bug — worth understanding properly, because the obvious version is wrong.**

The standard indexer idiom is `UNIQUE(chain_id, tx_hash, log_index)`. For most indexers, fine. For a
payment system, broken.

Here's why. Blockchains sometimes **reorganise** — a few blocks get replaced. A transaction that was
in block 100 gets re-included in block 101. Same transaction hash, different block.

With the standard unique key, that re-insert hits the conflict and gets **silently ignored**. The row
you keep still says "block 100" — a block that **no longer exists**.

Now you calculate confirmations: `currentBlock - 100`. You're counting depth from a block that
isn't on the chain. **You'll declare a payment final when it isn't.**

**The fix:** mark the old one orphaned, and make the uniqueness apply only to live rows:

```sql
CREATE UNIQUE INDEX ... ON raw_events (chain_id, tx_hash, log_index)
  WHERE NOT is_orphaned;
```

Both rows coexist. History intact, math correct.

**Can you answer this?** _"Why is `UNIQUE(chain_id, tx_hash, log_index)` wrong here?"_

---

## Block 4.2 — The chunk loop

Read a range of blocks, sort by `(block, logIndex)`, insert, advance the cursor. Cursor and inserts
commit **together** — so a crash mid-chunk just restarts from the saved cursor. Never read closer to
the tip than your confirmation depth.

Adaptive chunking: too many logs → halve the range; going well → grow it back.

---

## Block 4.3 — Handler registry

`@OnChainEvent({ contract, event })` marks a class as the handler for one event. At startup, scan
for them and **crash immediately** on a duplicate or an unknown event.

**Why crash?** Because it's a _programmer_ error. It will never fix itself, and starting up with a
missing handler means silently not processing payments. Loud at boot; isolated at runtime.

**Can you answer this?** _"Why crash on a duplicate handler instead of logging a warning?"_

---

## Block 4.4 — Reorg handling

Check that each block's `parentHash` matches the previous block's hash. If not, a reorg happened:
mark the affected events orphaned, rewind the cursor, re-read.

**The payments-specific part.** For a plain indexer, you just recalculate. Here, if you'd already
credited a merchant, you must post a **reversing ledger transaction** (Block 1.5). You never delete.
The history shows the credit _and_ the reversal.

**And the case with no fix.** If the reorg is _deeper than your confirmation depth_, and you've
already sent someone real money based on it — there is no code fix. The honest response is: reverse
what you can, flag it for a human, and page someone. This is why confirmation depth is a **risk
budget**: spend more of it where the action is irreversible. Payouts use double the depth of
settlements for exactly this reason.

**Can you answer this?** _"A reorg happens after you paid a merchant. Now what?"_

---

## Block 4.5 — Replay

Delete every calculated table, re-read the permanent logs, rebuild. No blockchain calls needed.

**The payoff.** Bug in a handler that's been wrong for three weeks? Fix the code, replay, done in
minutes. That's the entire reason for storing events instead of balances.

**Safety rail:** replay runs with `UPDATE`/`DELETE` revoked on the log tables — so a bug in replay
can't destroy the history it's reading from.

**Done when.** Test: run a workload → snapshot everything → wipe the calculated tables → replay →
assert identical.

---

# Part 5 — The fiat side

_Phase 5. Now the second source of truth._

## Block 5.1 — Build a fake card processor

**Why bother?** Because you cannot ask Stripe's test mode to _"duplicate this webhook, deliver the
next one out of order, then drop the third."_ Without that, every failure you've designed for is a
claim you can't test.

**Build.** A small service with payment endpoints and a `POST /_fault` endpoint that arms a specific
misbehaviour: `duplicate`, `reorder`, `delay`, `drop_webhook`, `wrong_amount`, `late_return`,
`clock_skew`, `bad_signature`.

**Design point:** faults are **armed deliberately**, never random. A test arms one, runs one payment,
asserts one outcome. A random chaos harness produces flaky tests, and flaky tests get deleted.

---

## Block 5.2 — `fiat_events` and the three-line webhook

**The idea.** This mirrors `raw_events` exactly. Same discipline, different source.

Your webhook endpoint does **three things and nothing else**:

1. Verify the signature
2. `INSERT ... ON CONFLICT DO NOTHING`
3. Return `200`

**No business logic in the request.** A separate worker processes the table afterwards.

**Why this matters so much.** The processor retries whenever you're slow or return an error. If you
do the work inline:

- Slow database → they think you failed → they retry → you process it twice
- You return `500` → the event may be lost entirely

Store it and return `200` instantly. Now duplicates hit the unique index, and an event that arrives
before you're ready just sits in the table until you are. **The whole class of problem disappears.**

**Can you answer this?** _"Why not just process the webhook in the request handler?"_

---

## Block 5.3 — Signature verification

HMAC-SHA256 over the **raw request body** (not the re-serialized JSON — key order changes and the
signature breaks), compared with `crypto.timingSafeEqual`, plus a timestamp within ±5 minutes so an
old captured request can't be replayed.

**Worth stating plainly:** a signature failure has **no innocent explanation** in a working system.
Check your deployed secret first — that's the one boring cause — but otherwise this is a security
incident, not a data problem.

---

## Block 5.4 — The dispatcher: handling "wrong order"

**The problem.** A refund event arrives before its capture event. Now what? Crash? Ignore it?

**The idea.** Neither. Sort every unexpected event into exactly one of three buckets:

| Bucket    | Meaning                         | Response                         |
| --------- | ------------------------------- | -------------------------------- |
| `IGNORE`  | Already past this — a duplicate | Do nothing, count it             |
| `DEFER`   | Too early, but valid later      | Retry with backoff               |
| `ILLEGAL` | Can never be valid from here    | Dead-letter and **page someone** |

Refund-before-capture is `DEFER` — wait, it'll make sense soon.

The `ILLEGAL` case that matters: **the payment was marked failed, then a capture arrives.** That
means you told a customer "declined" and then took their money. That needs a human, immediately, plus
an automatic refund.

**Can you answer this?** _"A refund webhook arrives before its capture webhook. What happens?"_

---

## Block 5.5 — The outbox

**The problem (the "dual write").** You need to update your database _and_ call an external service.
They can't share a transaction. If the DB commits and the call fails, they've diverged.

**The idea.** Don't call anything directly. Write a **to-do row in the same transaction** as your
state change. A worker picks it up afterwards.

Either both the state change and the to-do item are saved, or neither is. No middle state.

**The critical detail that makes it safe:** the to-do row's `dedupe_key` **is** the idempotency key
you send to the external service. Delivery is at-least-once, so a message _will_ sometimes be
processed twice — and when it is, the processor sees the same key and returns the original result
instead of charging again.

Workers claim rows with `FOR UPDATE SKIP LOCKED`. Retry with exponential backoff. After N attempts,
mark it `dead` and alert.

**Can you answer this?** _"How do you guarantee a database change and an external API call both
happen?"_

---

## Block 5.6 — Test every fault

One test per fault kind. Arm it, run a payment, assert the designed outcome. Each of these maps to a
row in [`failure-modes.md`](failure-modes.md).

---

# Part 6 — The first complete flow

_Phase 6. Everything connects. This is the payoff._

## Block 6.1 — `payment_intents` and freezing the price

**The idea.** One row per payment attempt, holding the whole state.

**The design detail that matters:** when you create the intent, **copy in** the fee rate, the exchange
rate, and the merchant's wallet address. Don't look them up later.

Why? A merchant changes their wallet address while a payment is in flight. If you read the address at
settlement time, the money goes somewhere the customer never agreed to. **A configuration change must
never retroactively alter a payment already underway.**

**Can you answer this?** _"Why snapshot the fee rate instead of reading the merchant's current one?"_

---

## Block 6.2 — Idempotency keys

The client sends `Idempotency-Key: abc`. Store it with a hash of the request body.

- Same key, same body, already done → **return the saved response**
- Same key, same body, in flight → `409`, try again shortly
- **Same key, DIFFERENT body → `422`, refuse entirely**

That third case is the one people forget. It means a bug is reusing keys, and processing it would
create a payment nobody intended.

**Can you answer this?** _"Same idempotency key, different request body. What do you return?"_

---

## Block 6.3 — `saga_transitions`

Every state change is a row: `(from, to, what caused it)`, with
`UNIQUE(saga_type, saga_id, cause_type, cause_id)`.

**Read that constraint carefully.** It says: _the transition caused by webhook `evt_123` may exist
once._ If the same cause is applied twice, **the database rejects it**. You never write "have I
already handled this?" — you cannot handle it twice.

**Can you answer this?** _"Where does idempotency live in your saga?"_ (In an index, not in code.)

---

## Block 6.4 — Wire up the on-ramp

Now connect everything you've built:

```
create intent → screen → charge card (outbox → PSP)
             → webhook lands in fiat_events
             → dispatcher advances the saga, posts to the ledger
             → reserve treasury float
             → submit chain transaction (outbox → submitter)
             → indexer sees PaymentSettled at depth
             → merchant credited
```

**Watch what happens when the treasury is low:** the payment **parks** in `awaiting_liquidity`. It
doesn't fail. Parking is a first-class outcome — the payment is fine, we just need to top up. Failing
would discard a perfectly good payment for a temporary operational reason.

**Done when.** One command produces a payment that goes all the way through.

---

## Block 6.5 — The API

`POST /payment-intents`, `GET /merchants/:id/balance`, `GET /health`.

**One rule:** the API reads **only calculated tables**. It never calls the blockchain and never calls
the card processor. Those are slow, they fail, and they'd make your API's reliability depend on
someone else's.

---

## Block 6.6 — The UI, and one honest badge

A checkout form and a merchant balance. Small on purpose.

The one piece worth care: **"data as of block N · lag 4s."**

Your data is always slightly behind reality. Every system like this is. Most hide it behind a
spinner. Showing it is a deliberate statement: _this system is eventually consistent, I know exactly
how far behind it is, and I'm telling you._

---

# Part 7 — Proving it's right

_Phase 7. This is what separates a demo from something believable._

## Block 7.1 — The invariants

Background jobs that continuously check _"do our books match reality?"_

| Check                                        | Question it answers                                          |
| -------------------------------------------- | ------------------------------------------------------------ |
| Trial balance = 0                            | Is our accounting internally consistent?                     |
| `totalSupply()` == our record                | Does the chain agree about how many tokens exist?            |
| `balanceOf(treasury)` == our record          | Does the chain agree about what we hold?                     |
| **Reserve coverage ≥ 1**                     | **Do we hold enough real money to back every token issued?** |
| Every treasury outflow has a matching record | **Did anyone move our money without us?**                    |

**The last one is the most serious alert in the system.** Tokens left the treasury and there's no
record of us sending them. The runbook says: _assume the key is compromised. Freeze first,
investigate second._

**And here's the subtle skill:** the _direction_ of a mismatch tells you what it is.

- Chain shows more than us + indexer is behind → just lag, it'll fix itself
- Chain shows more than us + indexer is fine → **someone else used our key**
- We show more than the chain → we credited too early, which is a real loss
- The processor has a charge we don't → dropped webhook, our poller recovers it
- **We have a charge the processor doesn't** → nobody sent that. **Forged webhook.**

Same number, five completely different responses.

**Can you answer this?** _"Your on-chain balance doesn't match your database. What do you do?"_

---

## Block 7.2 — Metrics, and one real constraint

Around 45 metrics. But there's a rule that will bite you, and working _with_ it is the lesson:

> **Never use an ID as a metric label.** No merchant ids, no addresses, no transaction hashes.

Why: Prometheus creates a separate time series for every unique label combination. A thousand
merchants means a thousand series **per metric**. That's how you take down your monitoring.

So when you want "which merchants have a mismatch?", you **can't** label by merchant. Instead:
export the _count_ and the _worst case_, and look up **which** merchant only when the alert fires.

IDs go in **traces and logs**, where cardinality is free and where you actually want them at 3am.

**Can you answer this?** _"Why can't you label a metric with a customer id?"_

---

## Block 7.3 — Dashboards

Six, but one matters most: **Money Truth**. A single big number — reserve coverage — reading
`1.000`.

Then, on camera, inject a fault and watch it dip. That's the demo.

---

## Block 7.4 — Alerts and the runbook

Every alert gets a runbook entry: what it means, likely causes, what to do, how to verify it's fixed.

**The habit worth forming:** write the runbook entry **while** you build the thing that alerts. Not
after. You'll never have more context than right now.

---

## Block 7.5 — The load generator

Traffic, so the dashboards aren't flat. Include deliberate duplicate requests so the idempotency path
runs continuously, and periodically trigger faults so the failure paths appear in the demo too.

**Underrated.** "Grafana with flat lines" is how a project like this falls flat.

---

# Parts 8–13 — After the core

Once Part 7 is done, **you have a complete, defensible project.** Everything below is depth, and the
[cut list](build-plan.md#31-cut-order) says what to drop if time runs out.

| Part   | What                       | New idea                                                                                             |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| **8**  | Refunds                    | Compensation ordering: **chain first, then card.** The reverse order can lose money with no recovery |
| **9**  | Payouts                    | The burn is **irreversible**. Everything reversible happens strictly before it                       |
| **10** | Compliance                 | Three separate checks, not one. **Fails closed** — never pay out on an unknown result                |
| **11** | Chaos tests                | Simulated reorgs and crash injection. Proves Parts 3 and 4                                           |
| **12** | Stripe adapter             | Same interface, real provider. Proves the abstraction wasn't a toy                                   |
| **13** | Batching, gasless payments | Optimizations. First to cut                                                                          |

---

# The questions this project prepares you for

If you can answer these, you've understood it — not just built it.

1. Why can't the card charge and the chain transaction be atomic? What do you do instead?
2. Why sign and persist a transaction _before_ broadcasting it?
3. Transaction #5 is stuck and #6, #7 are behind it. What do you do, and what do you **not** do?
4. Why is a transaction receipt not enough to credit a merchant?
5. A reorg happens after you credited someone. Walk me through it.
6. How do you know your ledger is correct? _(You point at a test.)_
7. Same idempotency key, different body. What do you return, and why?
8. A refund webhook arrives before its capture. What happens?
9. Your on-chain balance and your database disagree. How do you tell lag from theft?
10. Which single metric would you page on at 3am? _(Reserve coverage.)_

---

## How to actually work through this

- **One block per session.** They're sized for it.
- **Write the test in the same block as the code.** Not later. Later never comes.
- **Commit at the end of every block.** Small, working, conventional message.
- **If you can't answer the question at the end of a block, stop and go back.** The code compiling is
  not the goal.
- **Don't skip ahead.** Part 3 will not make sense without Part 1, and Part 6 is meaningless without
  3, 4 and 5.
