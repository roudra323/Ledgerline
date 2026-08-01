# ADR-0010 — `raw_events` uses a partial unique index

**Status:** Accepted — supersedes the uniqueness rule in the original indexer design

## Context

The inherited design specified:

```sql
UNIQUE (chain_id, tx_hash, log_index)
```

with `ON CONFLICT DO NOTHING` on insert. For a staking indexer this is fine. For a payment system it
is a **bug**, and it took building the reorg tests to see why.

On a reorg, a transaction is frequently re-included — in a different block, sometimes at a different
`log_index`. Under a _total_ unique key on `(chain_id, tx_hash, log_index)`:

- the re-inclusion at the same `log_index` is silently swallowed by `DO NOTHING`;
- the surviving row keeps the **stale, orphaned `block_number` and `block_hash`**;
- confirmation-depth math (`head - block_number >= confirmations_required`) is then computed against
  a block that is no longer canonical.

The consequence is a payment that appears confirmed based on an orphaned block. That is exactly the
class of error the confirmation policy exists to prevent.

## Decision

```sql
ALTER TABLE raw_events ADD COLUMN is_orphaned  boolean     NOT NULL DEFAULT false;
ALTER TABLE raw_events ADD COLUMN orphaned_at  timestamptz NULL;

CREATE UNIQUE INDEX raw_events_canonical_uk
  ON raw_events (chain_id, tx_hash, log_index)
  WHERE NOT is_orphaned;

CREATE INDEX raw_events_block_hash_idx ON raw_events (chain_id, block_hash);
```

The orphaned copy and the canonical copy coexist. History is preserved _and_ correctness is restored.
All confirmation math, all handler dispatch and all replay read only `WHERE NOT is_orphaned`.

## Alternatives considered

| Alternative                                                                | Why it lost                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the total unique key, `UPDATE` the row's block fields on re-inclusion | Mutates an append-only log. It destroys the evidence that a reorg happened, which is precisely what you need during the incident, and it breaks replay determinism because the log no longer records what we actually saw. |
| Delete orphaned rows                                                       | Same objection, worse: the log stops being append-only, and `DELETE` is revoked on log tables by [ADR-0004](0004-double-entry-ledger.md)'s discipline anyway.                                                              |
| Add `block_hash` to the unique key                                         | Works for the coexistence problem, but makes the _canonical_ uniqueness unenforceable: nothing then stops two non-orphaned rows for the same log at different block hashes, which is the actual invariant we want.         |
| Version rows with a `revision` counter                                     | More machinery for the same outcome, and every query grows a "latest revision" subquery. `is_orphaned` is a boolean the reorg guard already needs to set.                                                                  |
| Handle it in application code                                              | The whole reason this bug existed is that the constraint expressed the wrong thing. Moving it to application code makes it easier to get wrong, not harder.                                                                |

## Consequences

**Good.** Reorg history is fully queryable. "Show me every event that was orphaned and re-included,
and at what depth" is one `WHERE` clause, which makes the `ReorgBeyondConfirmations` runbook entry
actionable.

**Good.** Confirmation math is correct by construction, because it reads a canonical row or no row.

**Good.** Replay determinism is preserved — replaying the log reproduces the orphaning and the
re-inclusion in the order they were observed.

**Bad.** Every read of `raw_events` must remember `WHERE NOT is_orphaned`. Mitigation: reads go
through a repository method that applies the filter, and the raw table is not queried directly
outside it.

**Bad.** The table grows with orphaned duplicates. On Anvil this is noise; at real volume it would
want a retention policy for orphaned rows older than some window. Noted, not implemented.

## Note

This was a real defect inherited from the pre-pivot design, found by reasoning through the reorg test
before writing it. It is recorded here rather than quietly fixed, because the _reason_ the original
key looked correct — it is the standard indexer idiom — is the useful part.
