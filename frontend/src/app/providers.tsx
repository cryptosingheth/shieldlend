"use client";

import { WagmiProvider, createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { injected } from "wagmi/connectors";
import { NoteKeyProvider } from "@/lib/noteKeyContext";
import { StealthKeyProvider } from "@/lib/stealthKeyContext";
import { ViewingKeyProvider } from "@/lib/viewingKeyContext";

const config = createConfig({
  chains: [baseSepolia],
  connectors: [injected()],
  transports: { [baseSepolia.id]: http() },
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <NoteKeyProvider>
          <StealthKeyProvider>
            <ViewingKeyProvider>
              {children}
            </ViewingKeyProvider>
          </StealthKeyProvider>
        </NoteKeyProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
