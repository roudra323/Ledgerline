# Ledgerline Agent Instructions

Always follow the binding project conventions and rules defined in `CLAUDE.md`, `docs/conventions.md`, and `.agents/rules/conventions.md`.

- **Working Rhythm**: `make it work → make it correct (tests) → make it observable → commit.`
- **Money Handling**: Integer minor units as strings (`AmountMinor`), floor division + fee derivation, journal rounding residuals. Never JS `number`.
- **Fail Loud at Boot**: Validate all environment variables at startup.
- **Progress Tracking**: Update `docs/progress.md` in the same commit as the work.
- **Code Style**: Use guard clauses first (`if (...) { throw ... }`), explicit return types, double quotes, no `any`, no non-null `!`, comment the _why_ not the _what_.
