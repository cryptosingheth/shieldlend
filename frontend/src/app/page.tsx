"use client";

import { useState, useEffect } from "react";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { DepositForm } from "@/components/DepositForm";
import { WithdrawForm } from "@/components/WithdrawForm";
import { BorrowForm } from "@/components/BorrowForm";

type Tab = "deposit" | "withdraw" | "borrow";

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [tab, setTab] = useState<Tab>("deposit");
  const [mounted, setMounted] = useState(false);
  // Avoid SSR/client hydration mismatch — chain state is client-only
  useEffect(() => { setMounted(true); }, []);
  const isWrongNetwork = mounted && isConnected && chainId !== baseSepolia.id;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">ShieldLend</h1>
          <p className="text-xs text-zinc-500">Private DeFi lending · Horizen L3 + zkVerify</p>
        </div>
        {/* Gate on mounted — wagmi reconnects on client, not server */}
        {mounted && isConnected ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 font-mono">
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </span>
            <button
              onClick={() => disconnect()}
              className="text-xs px-3 py-1.5 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={() => connect({ connector: connectors[0] })}
            className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-medium transition-colors"
          >
            Connect Wallet
          </button>
        )}
      </header>

      {/* Wrong network banner */}
      {isWrongNetwork && (
        <div className="bg-red-900/60 border-b border-red-700 px-6 py-2 flex items-center justify-between text-sm">
          <span className="text-red-300">Wrong network — contracts are on Base Sepolia</span>
          <button
            onClick={() => switchChain({ chainId: baseSepolia.id })}
            className="text-xs px-3 py-1 bg-red-700 hover:bg-red-600 rounded font-medium transition-colors"
          >
            Switch to Base Sepolia
          </button>
        </div>
      )}

      {/* Privacy notice */}
      <div className="max-w-2xl mx-auto mt-8 px-4">
        <div className="border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 bg-zinc-900/50">
          <strong className="text-zinc-200">How ShieldLend works:</strong> Deposit ETH into the
          shielded pool to receive a private note. Use your note to borrow against your collateral
          without revealing your identity, or withdraw to any address — unlinking your deposit from
          your withdrawal.
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800 mt-8">
          {(["deposit", "withdraw", "borrow"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-3 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? "border-b-2 border-indigo-500 text-indigo-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="mt-6">
          {tab === "deposit" && <DepositForm />}
          {tab === "withdraw" && <WithdrawForm />}
          {tab === "borrow" && <BorrowForm />}
        </div>
      </div>
    </main>
  );
}
