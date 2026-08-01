# @ledgerline/web

The demo UI. Deliberately small — it exists to make the demo visceral, not to show off React.

Phase 6:

- a checkout: create a payment intent, pay with the mock PSP
- a merchant view: balance from the API (the ledger), payment history
- a **"data as of block N · lag Xs"** badge fed by `/health`

That badge is the point of the whole page. The system is eventually consistent, and surfacing that
honestly is a design decision worth showing rather than hiding behind a spinner.
