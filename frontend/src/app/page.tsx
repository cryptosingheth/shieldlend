"use client";

import { useState, useEffect } from "react";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { DepositForm } from "@/components/DepositForm";
import { WithdrawForm } from "@/components/WithdrawForm";
import { BorrowForm } from "@/components/BorrowForm";
import { Dashboard } from "@/components/Dashboard";
import { History } from "@/components/History";

type Tab = "dashboard" | "deposit" | "withdraw" | "borrow" | "history";

const TAB_LABELS: Record<Tab, string> = {
  dashboard: "Dashboard",
  deposit: "Deposit",
  withdraw: "Withdraw",
  borrow: "Borrow",
  history: "History",
};

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [mounted, setMounted] = useState(false);
  const [withdrawStatus, setWithdrawStatus] = useState<string>("idle");

  // Avoid SSR/client hydration mismatch — chain state is client-only
  useEffect(() => { setMounted(true); }, []);
  const isWrongNetwork = mounted && isConnected && chainId !== baseSepolia.id;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">ShieldLend</h1>
            <p className="text-xs text-zinc-600">Private DeFi lending · zkVerify + Base Sepolia</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Network badge */}
          {mounted && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-zinc-700 text-zinc-400">
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected && !isWrongNetwork ? "bg-green-400" : "bg-zinc-600"}`} />
              Base Sepolia
            </span>
          )}

          {/* Wallet */}
          {mounted && isConnected ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 font-mono hidden sm:inline">
                {address?.slice(0, 6)}...{address?.slice(-4)}
              </span>
              <button
                onClick={() => disconnect()}
                className="text-xs px-3 py-1.5 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
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
        </div>
      </header>

      {/* ── Wrong network banner ───────────────────────────────────────────── */}
      {isWrongNetwork && (
        <div className="bg-red-900/40 border-b border-red-800/60 px-6 py-2 flex items-center justify-between text-sm">
          <span className="text-red-300 text-xs">Wrong network — contracts are on Base Sepolia</span>
          <button
            onClick={() => switchChain({ chainId: baseSepolia.id })}
            className="text-xs px-3 py-1 bg-red-700 hover:bg-red-600 rounded font-medium transition-colors"
          >
            Switch
          </button>
        </div>
      )}

      {/* ── Withdrawal in-progress banner (shown on all tabs when active) ──── */}
      {["flushing", "fetching-path", "proving", "zkverify", "submitting"].includes(withdrawStatus) && (
        <div className="border-b border-indigo-800/60 bg-indigo-950/40 px-6 py-2.5 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
            </span>
            <span className="text-indigo-300 text-xs">
              {{
                "flushing":      "Flushing epoch to Merkle tree...",
                "fetching-path": "Fetching Merkle inclusion path...",
                "proving":       "Generating ZK proof — this takes ~20s...",
                "zkverify":      "Submitting proof to zkVerify...",
                "submitting":    "Sending withdrawal transaction...",
              }[withdrawStatus] ?? "Withdrawal in progress..."}
            </span>
          </div>
          {tab !== "withdraw" && (
            <button
              onClick={() => setTab("withdraw")}
              className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2 transition-colors"
            >
              View
            </button>
          )}
        </div>
      )}

      {/* ── Tabs + content ─────────────────────────────────────────────────── */}
      <div className="max-w-2xl mx-auto px-4 pb-16">

        {/* Tab nav */}
        <div className="flex border-b border-zinc-800 mt-8 overflow-x-auto">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                tab === t
                  ? "border-b-2 border-indigo-500 text-indigo-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {TAB_LABELS[t]}
              {/* Pulsing dot on Withdraw tab when operation is in progress */}
              {t === "withdraw" && ["flushing", "fetching-path", "proving", "zkverify", "submitting"].includes(withdrawStatus) && (
                <span className="ml-1.5 inline-flex h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="mt-6">
          {tab === "dashboard" && <Dashboard />}
          {tab === "deposit" && (
            <>
              <div className="border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 bg-zinc-900/50 mb-6">
                Deposit ETH into the shielded pool. You'll receive a private note — back it up
                securely. It's your only proof of ownership.
              </div>
              <DepositForm />
            </>
          )}

          {/* WithdrawForm and BorrowForm stay mounted while a proof/zkVerify operation is
              in flight — CSS-hidden tabs keep async state alive across navigation. */}
          <div className={tab === "withdraw" ? "" : "hidden"}>
            <div className="border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 bg-zinc-900/50 mb-6">
              Withdraw using your private note. The withdrawal is unlinkable to your original
              deposit — send to any address.
            </div>
            <WithdrawForm onStatusChange={setWithdrawStatus} />
          </div>

          <div className={tab === "borrow" ? "" : "hidden"}>
            <BorrowForm />
          </div>

          {tab === "history" && (
            <>
              <div className="border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 bg-zinc-900/50 mb-6">
                Protocol-wide event history. Deposit and withdrawal amounts are public; depositor
                and withdrawer addresses are not linked.
              </div>
              <History />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
