import type { ReactNode } from "react";

export const metadata = {
  title: "ChainStake",
  description: "Event-sourced staking demo — balances derived from on-chain events.",
};

// TODO(Phase 5): wrap children in WagmiProvider + QueryClientProvider (config in app/providers.tsx).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
