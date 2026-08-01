# ADR-0006 — Sign and persist before broadcasting

**Status:** Accepted

## Context

The inherited indexer design is read-only. A payment rail must _write_ to the chain, and that
introduces the hardest correctness problem in the system: a broadcast is an irreversible action
against a system that will happily accept a duplicate, and the network can partition at any point
between "we decided to send" and "we know it landed."

On EVM chains, one stuck transaction blocks every later transaction from the same account, so nonce
management is not a detail — it is the availability story.

## Decision

```
BEGIN
  SELECT * FROM chain_accounts WHERE chain_id=$1 AND address=$2 FOR UPDATE;  -- serialize
  -- guard: is_frozen → abort
  nonce := next_nonce;  UPDATE chain_accounts SET next_nonce = nonce + 1;
  INSERT INTO chain_transactions (…, nonce, intent_key, status='signing')
    ON CONFLICT (intent_key) DO NOTHING;          -- idempotent entry point
  -- policy check + SignerPort.sign() happen HERE, inside the transaction
  INSERT INTO chain_tx_attempts (attempt_number, tx_hash, raw_tx, …, broadcast_at = NULL);
  UPDATE chain_transactions SET status='signed';
COMMIT;
-- ONLY NOW:
eth_sendRawTransaction(raw_tx);
```

Plus `pg_advisory_lock(hashtext(chain_id || address))` around the submitter loop, so only one process
per account ever escalates gas or fills a nonce hole even with two replicas running.

Pre-flight `eth_call` simulation before signing: if it reverts, **do not consume a nonce** — move the
saga to the appropriate blocked state with the decoded custom error.

**Escalation rule that matters:** only ever escalate `MIN(nonce) WHERE status='submitted'` for an
account. Bumping a later transaction to fix a hole is useless — it cannot be mined behind the hole —
and burns fees.

## Alternatives considered

| Alternative                                               | Why it lost                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broadcast first, then record                              | The crash window loses a transaction you cannot identify. Recovery means scanning the chain for transactions from your address and reverse-engineering intent — and if the nonce counter was also in memory, you cannot even tell whether that nonce was used. |
| Fetch the nonce from `eth_getTransactionCount('pending')` | Racy under concurrency (two workers get the same nonce), and `pending` is a _node-local opinion_ that differs between providers and lies during mempool churn.                                                                                                 |
| In-memory nonce counter                                   | Lost on restart. Either a gap (everything after stalls) or a duplicate (one transaction silently replaces another). Fatal either way.                                                                                                                          |
| Redis or a distributed lock service                       | Another container and another partition-tolerance problem, when `SELECT FOR UPDATE` on a one-row table already gives perfect serialization at our scale.                                                                                                       |
| A managed relayer (OpenZeppelin Defender, Gelato)         | The correct production answer, and it ships exactly this loop. Wrong here for the same reason as Temporal in [ADR-0003](0003-saga-tables.md): it hides the machinery this project exists to demonstrate.                                                       |
| Skip simulation, let failures revert on-chain             | Every avoidable revert consumes a nonce and costs gas, and turns a cheap well-labelled off-chain state into an on-chain incident. Simulation converts the _majority_ of failures into `blocked_*` states with a decoded reason.                                |

## Consequences

**Good.** A signed raw transaction is deterministic bytes with a fixed hash. Recovery after a crash
at _any_ point is uniformly "re-broadcast every attempt whose parent is not confirmed."
Re-broadcasting an already-mined transaction returns `already known` or `nonce too low` — **success
signals, not errors.** Idempotency comes free from the EVM itself.

**Good.** Every broadcast is a row. `chain_tx_attempts` is a complete history of what we sent and at
what fee, which makes the gas-escalation dashboard and the stuck-transaction runbook possible.

**Good.** The `intent_key` unique index means the submitter has an idempotent entry point: calling it
twice for the same saga step is a no-op, not a double spend.

**Bad.** Signing inside a database transaction holds a row lock across the signer call. With a
`LocalDevSigner` that is microseconds; with `KmsSigner` it is a network round-trip, and a KMS outage
would hold the lock for the request timeout. Mitigation: a short, explicit statement timeout on the
submit transaction, and one account per role so a stall on one does not block the others.

**Bad.** We hold signed transactions that were never broadcast, which look like pending liabilities
until reconciled. `chain_transactions.status = 'signed'` with a null `broadcast_at` is exactly that
state, and the recovery loop is what resolves it.
