# @ledgerline/shared

The cross-workspace contract: ABIs, domain types, deployed addresses. Deliberately small.

- `types/` — `AmountMinor` (always a string, never a JS `number`), `AssetCode`, event name unions,
  `DeployedAddresses`.
- `abis/` — to be generated from `forge build` by `pnpm abi:gen`. **Generated, never hand-edited.**
  Today `abi:gen` is a placeholder and `abis/` is empty (Block 2.7).
- `addresses.ts` — to be loaded from the deployer's `addresses.local.json`; today a zero-address
  placeholder (Block 2.7).

Cross-package imports go through this package rather than deep relative paths.
