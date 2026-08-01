# Summary

<!-- What does this PR change, and why? Link the build-plan phase if relevant. -->

Phase: <!-- e.g. Phase 1 -->

## Changes

-

## How to test

<!-- Commands / steps a reviewer runs to verify this end-to-end. -->

## Checklist

<!-- See docs/conventions.md §13. -->

- [ ] Behavior covered by a test (unit / integration as appropriate)
- [ ] Metrics/spans added for any new indexer or API path
- [ ] Errors handled at the right layer with context; nothing swallowed
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm format:check` clean (and `forge fmt --check` if contracts changed)
- [ ] Conventional commit messages
- [ ] No secrets, `.env`, or generated artifacts committed
