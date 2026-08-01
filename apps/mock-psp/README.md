# @ledgerline/mock-psp

A deterministic fake payment provider, and the chaos harness for the fiat rail.

## Why this exists

A real PSP in test mode cannot be told _"duplicate this webhook, then deliver the next one out of
order, then drop the third."_ Without that ability, every failure mode in group A of
[`failure-modes.md`](../../docs/failure-modes.md) is a claim rather than a tested behaviour.

It also lets CI run the whole fiat rail offline, deterministically, with no secrets.

## Fault injection

```bash
curl -XPOST localhost:4001/_fault -d '{"kind":"duplicate","count":1}'
curl -XPOST localhost:4001/_fault -d '{"kind":"wrong_amount","amountDeltaMinor":"-500"}'
curl -XDELETE localhost:4001/_fault
```

| Kind            | Simulates                                 | Failure mode |
| --------------- | ----------------------------------------- | ------------ |
| `duplicate`     | Webhook delivered twice                   | A1           |
| `reorder`       | Refund arriving before its capture        | A3           |
| `delay`         | Slow delivery                             | A2           |
| `drop_webhook`  | Delivery lost; the poller must recover it | A5           |
| `fail_capture`  | A decline                                 | —            |
| `wrong_amount`  | Captured amount ≠ quoted                  | A9           |
| `late_return`   | An ACH return days later                  | A16          |
| `clock_skew`    | Skewed provider timestamps                | A8           |
| `bad_signature` | Wrong signing secret                      | A6           |

Faults are **armed, not random.** A test arms exactly one, runs one payment, and asserts the
designed outcome. A flaky chaos harness gets disabled; a deterministic one gets trusted.
