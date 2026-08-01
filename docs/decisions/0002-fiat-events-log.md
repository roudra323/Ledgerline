# ADR-0002 — The off-chain rail gets its own append-only log

**Status:** Accepted

## Context

The inherited design has one source of truth: the chain, ingested into an append-only `raw_events`
table keyed by a provider-supplied identity. A payment rail has a _second_ source of truth — the
PSP — with the same properties and the same hazards: we do not control it, it retries, it delivers
out of order, and it can deliver before we are ready.

The natural instinct is to handle a webhook the way you handle any HTTP request: verify it, do the
work, return 200. That instinct is wrong, and it is wrong in a way that produces duplicate charges.

## Decision

`fiat_events` mirrors `raw_events` exactly:

```
UNIQUE (provider, provider_event_id)      -- the dedupe guarantee
payload            jsonb   -- verbatim, parsed once, never re-serialized
payload_sha256     bytea   -- of the RAW bytes we verified the signature over
status             text    -- pending | processed | unmatched | deferred | failed | ignored
```

The webhook endpoint does **exactly three things**:

1. Verify the HMAC over the **raw body**, constant-time.
2. `INSERT ... ON CONFLICT DO NOTHING`.
3. Return `200`.

**No business logic in the HTTP request.** A separate dispatcher worker reads the table and advances
sagas.

## Alternatives considered

| Alternative                                                  | Why it lost                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process inline, return 200 after the business logic          | Couples the PSP's retry policy to our database latency. A slow handler causes PSP retries, which cause duplicate processing. Worse: a 500 loses the event entirely if it was never persisted.                                    |
| Push webhooks onto Redis or Kafka                            | New infrastructure and a new failure mode, and you _still_ need a durable dedupe store on the other side. The Postgres unique index **is** the dedupe — adding a broker in front adds a hop without adding a guarantee.          |
| Dedupe on a hash of the payload                              | Providers legitimately re-send byte-identical payloads under new event ids, and send _different_ payloads under the same event id after a retry-with-update. `provider_event_id` is the documented contract; the payload is not. |
| Return 4xx/5xx when we can't match the event to an aggregate | Hides the problem behind the provider's retry policy and turns a benign race into a duplicate storm. Persist, return 200, mark `unmatched`, and let our own backoff own the retry.                                               |

## Consequences

**Good.** Duplicate, out-of-order and too-early webhooks stop being incidents. A duplicate is an
`ON CONFLICT`; an early one is an `unmatched` row with a backoff; an out-of-order one is a `DEFER`.
All three are ordinary states with metrics, not exceptions.

**Good.** The system becomes symmetric: two logs, one discipline, one replay story. Anything we can
say about reorg recovery on the chain side has an analogue on the fiat side (see failure mode A16 —
an ACH return is a slow reorg).

**Good.** A forged webhook is detectable as a specific, high-severity condition — a `fiat_events`
row the PSP does not recognize has no benign explanation.

**Bad.** Two hops means the end-to-end latency of a capture is webhook → table → poll → dispatch.
Mitigated with `LISTEN/NOTIFY` as a latency optimization _on top of_ polling — never as the delivery
mechanism, because a notification delivered while no listener is connected is simply lost.

**Bad.** Storing verbatim payloads means storing whatever the PSP sends, which may include fields we
would rather not retain. The mock PSP emits nothing sensitive; for the Stripe adapter, the answer is
a documented redaction step before insert, and it is a real cost of this design.
