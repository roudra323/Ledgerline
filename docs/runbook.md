# Ledgerline — Runbook

What to do when an alert fires. Each entry: **meaning → likely causes → resolution → verify.**

Two standing rules:

1. **Never auto-heal a discrepancy.** Reconciliation runs in audit mode by default. Any correction is
   a reversing ledger transaction with `kind='reconciliation.adjustment'`, a memo, and an operator id.
   A system that silently self-heals has destroyed the evidence of the bug.
2. **Freeze before you investigate** when the alert is in the "someone else is moving our money"
   family. Freezing is reversible; a drained treasury is not.

---

# Pages

## UnknownTreasuryOutflow (page) — _the highest-severity alert in the system_

`increase(ledgerline_unknown_outflows_total[5m]) > 0` — invariant I8 found a `Transfer` with
`from = treasury` and **no matching `chain_transactions` row**.

- **Meaning:** value left our treasury via a transaction we did not create. **Assume key compromise
  until proven otherwise.**
- **Likely causes:** in order of what to check, not likelihood — (1) a key in use outside this
  system, e.g. someone running a script with the treasury key; (2) a submitter that wrote the chain
  transaction under a different `intent_key` than the handler looks up; (3) on a dev chain, a manual
  `cast send`.
- **Resolution:**
  1. **Freeze first.** `UPDATE chain_accounts SET is_frozen = true, freeze_reason = '<incident>'` for
     the affected role. The submitter halts on the next tick.
  2. Identify the transaction: find the `Transfer` in `raw_events`, take the `tx_hash`, and search
     Jaeger by that attribute. No trace means it did not originate here — that is the compromise
     case.
  3. If it is (2), the fix is in the handler's lookup key, not in the chain. Confirm by finding the
     `chain_transactions` row by nonce.
  4. If it is compromise: rotate the key, `configureMinter`/`removeMinter` as appropriate, and treat
     everything signed by that key since the last known-good point as suspect.
- **Verify:** `unknown_outflows_total` stops increasing; I3/I4 drift returns to 0; the account is
  unfrozen only after the root cause is named.

## TrialBalanceBroken (page)

`ledgerline_trial_balance_residual_minor != 0` for 1m.

- **Meaning:** a ledger transaction exists whose debits and credits do not sum to zero within an
  asset. Given the deferred constraint trigger, this should be **impossible**.
- **Likely causes:** it is **always a code bug** — a migration that dropped the trigger, a posting
  path that bypassed `LedgerService.post()`, or a direct `psql` write. It is never a data problem.
- **Resolution:**
  1. Find it: `SELECT transaction_id, asset_code, SUM(...) FROM ledger_entries GROUP BY 1,2 HAVING
SUM(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END) <> 0;`
  2. Confirm the trigger still exists (`\d+ ledger_entries`). If a migration dropped it, that is the
     bug.
  3. **Do not delete the unbalanced entries.** Post a reversing transaction with `reverses_id`, an
     operator id and a memo, then post the correct one.
- **Verify:** residual returns to exactly 0 for every asset; a regression test covers the path that
  produced it.

## ReserveCoverageLow (page)

`ledgerline_reserve_coverage_ratio < 1` for 5m — invariant I7.

- **Meaning:** we have issued more `USDX` than we hold fiat backing for. For a stablecoin issuer this
  is the definition of the fatal condition.
- **Likely causes:** (1) fee accounting timing — fees credited before PSP settlement, usually a small
  transient dip; (2) a mint that outran the fiat backing it — mints are treasury operations (`treasury.mint`, operator command or rebalance, never part of a payment; ADR-0013), so check the last one against `bank_settlement + psp_receivable` at the time it ran; (3) a chargeback that removed
  fiat while tokens stayed outstanding.
- **Resolution:**
  1. **Halt minting:** freeze the `treasury_minter` account.
  2. Decompose: compare `stablecoin_issued` against `psp_receivable + bank_settlement` on the Money
     Truth dashboard. Which side moved?
  3. If fiat fell → chargebacks (expected; the debt is recorded in `merchant_receivable`). If tokens
     rose → find the mint in `chain_transactions` and its `treasury.mint` posting, and the operator
     command or rebalance run that requested it.
- **Verify:** ratio ≥ 1; if it was case (2), the offending mint has a reversing burn.

## ReorgBeyondConfirmations (page)

A reorg was deeper than `confirmations_required` for an affected transaction kind.

- **Meaning:** we treated something as final that was not. **Downstream irreversible actions may
  already have fired.**
- **Resolution:**
  1. Enumerate what fired, in this order: fiat payouts (irreversible), token deliveries to merchants
     (irreversible), refunds issued (irreversible), merchant credits (reversible).
  2. Global payout freeze until an operator clears it.
  3. Affected sagas → `manual_review`. Reversing ledger transactions are posted automatically; the
     _business_ resolution is per-case.
  4. Reconsider the depth policy for that kind. Depth is a risk budget, and this alert means the
     budget was set too low.
- **Verify:** no saga remains in an inconsistent state; the depth constant is revisited in code with a
  comment explaining the new value.

---

# Critical

## SupplyDrift / TreasuryDrift

`ledgerline_supply_drift_minor` or `_treasury_drift_minor` `!= 0` for 10m — invariants I3, I4.

Decision tree — **direction tells you what it is:**

- **Chain ahead of ledger** _and_ `ledgerline_indexer_lag_seconds` elevated → indexer lag. It will
  self-resolve; confirm the lag is decreasing.
- **Chain ahead of ledger** _and_ lag is normal → check `unknown_outflows_total`. Non-zero → follow
  **UnknownTreasuryOutflow** above. Zero → a handler is failing; check `indexer_failures`.
- **Ledger ahead of chain** → we recorded something the chain does not show. Should be impossible
  (pending value sits in `merchant_payable` / `token_in_transit`). Run `ReplayService`. If replay resolves it, it was a
  projection bug — find it. **If replay does not resolve it, it was a premature credit, which is a
  real loss** — escalate.
- **Verify:** drift returns to 0 at `head - CONFIRMATIONS`, not at head. Comparing a settled ledger
  against unsettled chain state makes drift oscillate, which is why the reconciler is specified to read at depth (Block 7.1).

## ForgedFiatEvent

`increase(ledgerline_webhook_signature_failures_total[10m]) > 3`.

- **Meaning:** someone is sending us webhooks they cannot sign. **There is no benign explanation in a
  clean environment.** This is a security incident, not a reconciliation one.
- **Likely causes:** a rotated secret not yet deployed (check first — this is the one boring cause), a
  misconfigured provider, or an actual forgery attempt.
- **Resolution:** confirm the deployed secret matches the provider's. If it does, quarantine the
  source IP, rotate the signing secret, and audit `fiat_events` for any row we accepted in the window
  that the PSP does not recognize (invariant I6, "we ahead of PSP").
- **Verify:** failures stop; I6 shows no unrecognized rows.

## RpcDisagreement

`increase(ledgerline_receipt_disagreement_total[10m]) > 0`.

- **Meaning:** the two RPC providers disagree about the block hash at a confirming height. One of them
  is wrong or lagging.
- **Resolution:** pending irreversible fiat actions are already held automatically — confirm they are.
  Compare both providers at that height manually; the one whose chain does not extend is the stale
  one. If a provider is persistently wrong, remove it from the fallback list.
- **Verify:** providers agree; held payouts resume.

## StuckTransaction / NonceGap

`ledgerline_chain_tx_stuck > 0` or `ledgerline_chain_nonce_gap_depth > 0` for 5m.

- **Meaning:** a transaction is not being mined, and every later transaction from that account is
  stuck behind it.
- **Resolution — the rule that matters: fix the OLDEST, never bump a later one.**

  ```sql
  SELECT id, nonce, status, created_at
  FROM chain_transactions
  WHERE chain_id = $1 AND from_address = $2 AND status = 'submitted'
  ORDER BY nonce ASC LIMIT 1;   -- this one, and only this one
  ```

  If it is at the fee ceiling, `POST /admin/chain-tx/:id/cancel` — a new row with the **same nonce**,
  `to = self`, value 0, aggressive fees. When it confirms, the original moves to `abandoned` and its
  saga compensates.

- **Do not** raise the fee on a later nonce. It cannot be mined behind the hole and it burns gas.
- **Verify:** `MIN(nonce) WHERE status='submitted'` advances; gap depth returns to 0.

## SagaStuck / IllegalSagaTransition

- **`SagaStuck`** — sagas accumulating in `chain_submitted` or `fiat_submitted`. Check the
  corresponding rail: `chain_tx_stuck` for the chain side, `psp_request_duration_seconds` and
  `outbox_oldest_pending_seconds` for the fiat side.
- **`IllegalSagaTransition`** — a cause arrived that can _never_ be legal from the current state. This
  is either a bug in the transition table or a genuine rail anomaly. The important case is
  `capture_failed → captured` (failure mode A4): **we told a customer "declined" and then took their
  money.** An automatic compensating refund saga fires; confirm it did, then find out why the auth
  timeout was shorter than the PSP's capture window.

## OutboxDeadLetter

`increase(ledgerline_outbox_processed_total{result="dead"}[15m]) > 0`.

- **Meaning:** a message exhausted `max_attempts`. Something is permanently failing.
- **Resolution:** `SELECT kind, last_error, count(*) FROM outbox_messages WHERE status='dead' GROUP
BY 1,2;` Fix the cause, then requeue via the admin endpoint. Because `dedupe_key` is the downstream
  idempotency key, requeuing is always safe.
- **Verify:** the requeued messages reach `done`; the saga advances.

## IndexerStalled

`increase(ledgerline_chunks_processed_total[10m]) == 0`.

- **Likely causes:** both RPC providers down, DB unreachable, the scheduler tick wedged, or a poison
  event blocking dispatch.
- **Resolution:** check `rpc_provider_healthy` for both providers, then the DB pool, then
  `indexer_failures` for a repeating event. Restart is safe — the cursor is persisted and ingestion is
  idempotent.
- **Verify:** chunks resume; lag drains.

---

# Warnings

| Alert                     | Meaning                                                      | First action                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SagasInManualReview`     | Human-decision queue is non-empty                            | Work the queue; each has a `failure_code` pointing at a `failure-modes.md` entry                                                                                       |
| `GasBalanceLow`           | A signing account is running out of ETH                      | The auto-refill job should have fired — check `outbox_messages` for `kind='chain.gas_refill'`. Below the hard floor, sagas park in `awaiting_gas` rather than failing  |
| `FloatBelowMinimum`       | Treasury token float below `liquidity_positions.min`         | Run the operator mint (or confirm the rebalance job, if built, is running). Sagas park in `awaiting_liquidity`; they are not lost                                      |
| `MinterAllowanceLow`      | <20% of the minter allowance remains                         | **Deliberately not auto-topped-up** — the allowance is a safety limit. Raise it consciously, via `configureMinter`, with a reason                                      |
| `OutboxBacklog`           | Oldest pending message > 5 min                               | Check whether a downstream rail is slow (`psp_request_duration_seconds`) or the worker is not running                                                                  |
| `UnmatchedFiatEventAging` | A `fiat_events` row has had no matching aggregate for 15 min | Usually a webhook for something we never created. Check for a failed intent creation; if the PSP charged, an automatic refund is required                              |
| `ScreeningUnavailable`    | A screening provider is erroring                             | Sagas are parked, **not** credited — the system fails closed by design. Restore the provider; the queue drains                                                         |
| `IndexerLagHigh`          | Behind the chain head                                        | Check `chunk_size` (small = RPC pain), RPC latency, DB pool. If a catch-up is running, confirm `catchup_remaining_blocks` is decreasing                                |
| `RpcProviderDown`         | A provider is unhealthy                                      | Fallback should have taken over. Confirm the _other_ provider is healthy — with one provider left, the B10 cross-check cannot run, so pre-payout verification degrades |
| `ApiP95High`              | Route p95 > 500ms                                            | Jump from the Grafana panel into Jaeger for that window; look for `pg` spans                                                                                           |
