/**
 * Load generator — the "living data" engine for demos.
 *
 * TODO(Phase 5):
 *   - derive N accounts from DEV_MNEMONIC, fund them with MockToken (mint) + approve the vault.
 *   - loop: pick a random account + weighted random action (stake | withdraw | claim),
 *     fire the tx against Anvil (RPC_URL_PRIMARY) every 1–3s.
 *   - keep amounts bounded so withdraws never exceed stakes.
 * Runs as a compose service under the `demo` profile.
 */

function main(): void {
  console.log("[loadgen] stub — implemented in Phase 5. See TODO in infra/loadgen/src/index.ts");
}

main();
