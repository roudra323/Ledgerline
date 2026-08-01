# loadgen

Drives real payment traffic against the API so the dashboards have living data. **A first-class
deliverable, not an afterthought** — an observability stack with no traffic proves nothing, and
"Grafana with flat lines" is the most common way a demo like this falls flat.

What it does (Phase 7):

- `POST /payment-intents` across N merchants and customers at a configurable rate
- a weighted action mix: mostly on-ramp, some refunds (including partials), some payouts
- **replays a small fraction of requests with the same idempotency key**, so the dedupe path is
  exercised continuously rather than only in tests
- periodically calls the `mock-psp` fault API, so the _failure_ paths show up in the demo too

Runs as a compose service under `--profile demo`.
