# Ledgerline Agent Instructions

The binding rules live in exactly two files. Read both. Do not work from a summary — this file
deliberately contains **no rules of its own**, because a second copy of a rule is a second version
of the truth, and the two will disagree before anyone notices.

- [`CLAUDE.md`](CLAUDE.md) — golden rules, where facts live, working rhythm, definition of done
- [`docs/conventions.md`](docs/conventions.md) — the coding contract

`CLAUDE.md`'s **Where facts live** table tells you which single file owns any fact you need. When
two files disagree, the owner wins and the disagreement is a bug to report, not a reading to pick
between.

<!-- ssot:pointer-only — `pnpm docs:check` fails if this file grows rule text -->
