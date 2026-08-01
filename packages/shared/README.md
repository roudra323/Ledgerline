# @ledgerline/shared

The cross-workspace contract: ABIs, domain types, deployed addresses. Deliberately small.

- `types/` — `AmountMinor` (always a string, never a JS `number`), `AssetCode`, event name unions,
  `DeployedAddresses`.
- `abis/` — generated from `forge build` by `pnpm abi:gen`. **Generated, never hand-edited.**
- `addresses.ts` — loaded from the deployer's `addresses.local.json`.

Cross-package imports go through this package rather than deep relative paths.
