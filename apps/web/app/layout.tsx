import type { ReactNode } from "react";

export const metadata = {
  title: "Ledgerline",
  description: "A fiat ⇄ stablecoin payment rail with a real double-entry ledger.",
};

// TODO(Part 6): wrap children in QueryClientProvider (config in app/providers.tsx).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
