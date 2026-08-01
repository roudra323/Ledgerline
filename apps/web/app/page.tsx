export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: 680 }}>
      <h1 style={{ marginBottom: "0.25rem" }}>💵⇄🪙 Ledgerline</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        A fiat ⇄ stablecoin payment rail with a real double-entry ledger.
      </p>
      <p>Demo UI skeleton — the checkout, merchant balance and lag badge land in Phase 6.</p>
    </main>
  );
}
