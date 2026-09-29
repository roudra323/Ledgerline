# Architecture Decision Records

One file per significant decision. Each records the **context**, the **decision**, the
**alternatives considered and why each lost**, and the **consequences** — including the ones we
don't like.

ADR-0015 does not supersede [ADR-0001](0001-money-representation.md); it pins a unit ADR-0001 left
unspecified. ADR-0017 likewise refines, rather than replaces, [ADR-0004](0004-double-entry-ledger.md),
and ADR-0018 refines [ADR-0013](0013-treasury-float-model.md) by naming the accounts a mint posts to.

An ADR is immutable once merged. If a decision changes, add a new ADR that supersedes it and mark
the old one `Superseded by ADR-NNNN`. Never edit history; the reasoning that was wrong is as useful
as the reasoning that was right.

| #                                                         | Decision                                                                  | Status   |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| [0001](0001-money-representation.md)                      | Money is an integer minor unit of a named asset                           | Accepted |
| [0002](0002-fiat-events-log.md)                           | The off-chain rail gets its own append-only log                           | Accepted |
| [0003](0003-saga-tables.md)                               | Typed saga aggregates, not a generic workflow engine                      | Accepted |
| [0004](0004-double-entry-ledger.md)                       | Double-entry, enforced by the database                                    | Accepted |
| [0005](0005-outbox.md)                                    | One outbox table consumed with `FOR UPDATE SKIP LOCKED`                   | Accepted |
| [0006](0006-chain-write-path.md)                          | Sign and persist before broadcasting                                      | Accepted |
| [0007](0007-events-not-receipts.md)                       | Sagas advance on confirmed events, never on receipts                      | Accepted |
| [0008](0008-compensation-ordering.md)                     | Order compensations so the recoverable failure is last                    | Accepted |
| [0009](0009-on-chain-vs-off-chain.md)                     | On-chain only what must survive a compromised server                      | Accepted |
| [0010](0010-raw-events-partial-unique.md)                 | `raw_events` uses a partial unique index                                  | Accepted |
| [0011](0011-key-management.md)                            | Build the signing _policy_, not fake custody                              | Accepted |
| [0012](0012-compliance-ports.md)                          | Three screening ports, not one `isBlocked()`                              | Accepted |
| [0013](0013-treasury-float-model.md)                      | On-ramp both mints and transfers from a finite treasury                   | Accepted |
| [0014](0014-statuses-as-text.md)                          | Statuses are `text` + `CHECK`, not Postgres enums                         | Accepted |
| [0015](0015-rounding-residual-unit.md)                    | The FX rounding residual is denominated in the source asset               | Accepted |
| [0016](0016-transaction-kind-vocabulary.md)               | Ledger transaction kinds are `domain.event`                               | Accepted |
| [0017](0017-non-negative-enforcement.md)                  | The non-negative invariant is enforced by the trigger, under a row lock   | Accepted |
| [0018](0018-ledger-flow-postings.md)                      | The merchant is owed from the FX posting; issuance is a treasury posting  | Accepted |
| [0019](0019-ledger-trigger-error-contract.md)             | Ledger rejections are typed; the trigger locks only accounts with a floor | Accepted |
| [0020](0020-balances-projection-maintained-by-trigger.md) | The balance projection is maintained by the balance trigger               | Proposed |
