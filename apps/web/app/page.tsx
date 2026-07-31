/**
 * ChainStake demo home.
 *
 * TODO(Phase 5):
 *   - wagmi connect button (viem transport -> local Anvil).
 *   - stake / withdraw forms (write to StakingVault).
 *   - balance + history table polling the indexer API (NEXT_PUBLIC_API_URL).
 *   - "data as of block N / lag Xs" badge fed by GET /health/indexer (honest eventual consistency).
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>⛓️ ChainStake</h1>
      <p>Demo UI skeleton — see TODO(Phase 5) in app/page.tsx.</p>
    </main>
  );
}
