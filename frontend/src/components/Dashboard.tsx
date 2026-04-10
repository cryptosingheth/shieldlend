"use client";

import { useEffect, useState, useCallback } from "react";
import { formatEther } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import {
  SHIELDED_POOL_ADDRESS,
  SHIELDED_POOL_ABI,
  LENDING_POOL_ADDRESS,
  LENDING_POOL_ABI,
  NULLIFIER_REGISTRY_ADDRESS,
  NULLIFIER_REGISTRY_ABI,
} from "@/lib/contracts";
import { loadNotes, markNoteSpent, noteLabel, type StoredNote } from "@/lib/noteStorage";
import { useLoanDetails } from "@/lib/contracts";
import { useNoteKey } from "@/lib/noteKeyContext";

const DEPLOY_BLOCK = 39499000n;
const CHUNK_SIZE = 9000n;

async function getAllLogs(
  publicClient: ReturnType<typeof usePublicClient>,
  address: `0x${string}`,
  signal?: AbortSignal
) {
  if (!publicClient) return [];
  const latest = await publicClient.getBlockNumber();
  const allLogs = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK_SIZE) {
    if (signal?.aborted) return [];
    const to = from + CHUNK_SIZE - 1n < latest ? from + CHUNK_SIZE - 1n : latest;
    const chunk = await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
    allLogs.push(...chunk);
  }
  return allLogs;
}

interface PoolStats {
  totalDeposits: number;
  tvlWei: bigint;
  activeBorrowsWei: bigint;
  utilizationBps: number;
}

interface UserLoan {
  loanId: number;
  borrowed: bigint;
  totalOwed: bigint;
  repaid: boolean;
}

function hfColor(hf: number): string {
  if (hf >= 2.0) return "text-green-400";
  if (hf >= 1.5) return "text-amber-400";
  return "text-red-400";
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-zinc-800 rounded-xl p-5 bg-zinc-900/50">
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">{label}</p>
      <p className="text-2xl font-semibold font-mono text-zinc-100">{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  );
}

export function Dashboard() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { noteKey, isUnlocked, isUnlocking, unlock } = useNoteKey();
  const [mounted, setMounted] = useState(false);

  const [stats, setStats] = useState<PoolStats | null>(null);
  const [userLoans, setUserLoans] = useState<UserLoan[]>([]);
  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingSpent, setSyncingSpent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setMounted(true); }, []);

  // Load notes from localStorage (async in V2 due to encryption)
  const refreshNotes = useCallback(async () => {
    if (!address) return;
    const notes = await loadNotes(address, noteKey);
    setSavedNotes(notes);
  }, [address, noteKey]);

  useEffect(() => { refreshNotes(); }, [refreshNotes]);

  // ── NullifierRegistry on-load sync ──────────────────────────────────────
  // For each active note, check isSpent() on-chain. If the note was withdrawn
  // from a different device, this syncs the spent status back to localStorage.
  useEffect(() => {
    if (!publicClient || !address || savedNotes.length === 0) return;

    const activeNotes = savedNotes.filter((n) => !n.spent);
    if (activeNotes.length === 0) return;

    async function syncSpentStatus() {
      setSyncingSpent(true);
      try {
        for (const note of activeNotes) {
          const isSpent = await publicClient!.readContract({
            address: NULLIFIER_REGISTRY_ADDRESS,
            abi: NULLIFIER_REGISTRY_ABI,
            functionName: "isSpent",
            args: [note.nullifierHash as `0x${string}`],
          }) as boolean;

          if (isSpent) {
            await markNoteSpent(address!, note.nullifierHash, noteKey);
          }
        }
        // Refresh after sync
        await refreshNotes();
      } catch {
        // Non-fatal — sync failure doesn't break the UI
      } finally {
        setSyncingSpent(false);
      }
    }

    syncSpentStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, address, savedNotes.length]);

  useEffect(() => {
    if (!publicClient) return;
    const controller = new AbortController();
    const { signal } = controller;

    async function fetchStats() {
      try {
        setLoading(true);

        const nextIndex = await publicClient!.readContract({
          address: SHIELDED_POOL_ADDRESS,
          abi: SHIELDED_POOL_ABI,
          functionName: "nextIndex",
        }) as number;

        const TOPIC_DEPOSIT    = "0x5371f021da83c329fcf7058e2039d7c7384459a19a13baed1a0d9efbfb9d0ee6";
        const TOPIC_WITHDRAWAL = "0x4206db6775563d1043abfcf27cd0ecd19fcc464be574a1487fc95b24957a671a";

        const poolLogs = await getAllLogs(publicClient!, SHIELDED_POOL_ADDRESS, signal);
        let tvl = 0n;
        for (const log of poolLogs) {
          const t0 = log.topics[0] as string;
          if (t0 === TOPIC_DEPOSIT && log.data.length >= 194) {
            try { tvl += BigInt("0x" + log.data.slice(130, 194)); } catch {}
          } else if (t0 === TOPIC_WITHDRAWAL && log.data.length >= 130) {
            try { tvl -= BigInt("0x" + log.data.slice(66, 130)); } catch {}
          }
        }
        if (tvl < 0n) tvl = 0n;

        const borrowLogs = await getAllLogs(publicClient!, LENDING_POOL_ADDRESS, signal);
        let totalBorrowed = 0n;
        const loanIds: number[] = [];
        for (const log of borrowLogs) {
          // V2 Borrowed event: only emits loanId (topics[1]), no amount in data
          if (log.topics.length >= 2) {
            const loanId = parseInt(log.topics[1] as string, 16);
            if (!isNaN(loanId)) loanIds.push(loanId);
          }
        }

        // Aggregate borrowed amount by querying each loan's details
        for (const id of loanIds) {
          try {
            const d = await publicClient!.readContract({
              address: LENDING_POOL_ADDRESS,
              abi: LENDING_POOL_ABI,
              functionName: "getLoanDetails",
              args: [BigInt(id)],
            }) as unknown as { borrowed: bigint; repaid: boolean };
            if (!d.repaid) totalBorrowed += d.borrowed;
          } catch {}
        }

        const utilizationBps =
          tvl > 0n ? Number((totalBorrowed * 10000n) / tvl) : 0;

        setStats({
          totalDeposits: Number(nextIndex),
          tvlWei: tvl,
          activeBorrowsWei: totalBorrowed,
          utilizationBps,
        });

        if (address && loanIds.length > 0) {
          const details: UserLoan[] = [];
          for (const id of loanIds.slice(-20)) {
            try {
              const d = await publicClient!.readContract({
                address: LENDING_POOL_ADDRESS,
                abi: LENDING_POOL_ABI,
                functionName: "getLoanDetails",
                args: [BigInt(id)],
              }) as unknown as { borrowed: bigint; totalOwed: bigint; repaid: boolean };
              if (!d.repaid && d.borrowed > 0n) {
                details.push({ loanId: id, borrowed: d.borrowed, totalOwed: d.totalOwed, repaid: d.repaid });
              }
            } catch {}
          }
          setUserLoans(details);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load stats");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }

    fetchStats();
    return () => controller.abort();
  }, [publicClient, address]);

  const activeNotes = savedNotes.filter((n) => !n.spent);
  const spentNotes = savedNotes.filter((n) => n.spent);

  if (!mounted) return null;

  return (
    <div className="space-y-8">
      {/* ── Vault lock/unlock ─────────────────────────────────────────────── */}
      {address && (
        <div className="flex items-center justify-between border border-zinc-800 rounded-lg px-4 py-3 bg-zinc-900/40">
          <div>
            <p className="text-xs text-zinc-400 font-medium">
              Note vault: {isUnlocked ? (
                <span className="text-green-400">Unlocked</span>
              ) : (
                <span className="text-amber-400">Locked</span>
              )}
            </p>
            <p className="text-xs text-zinc-600 mt-0.5">
              {isUnlocked
                ? "Notes are AES-256-GCM encrypted in localStorage."
                : "Sign once to decrypt your notes for this session."}
            </p>
          </div>
          {!isUnlocked && (
            <button
              onClick={unlock}
              disabled={isUnlocking}
              className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50
                         text-white rounded-lg transition-colors"
            >
              {isUnlocking ? "Signing..." : "Unlock vault"}
            </button>
          )}
          {syncingSpent && (
            <span className="text-xs text-zinc-600 animate-pulse ml-3">Syncing spent status...</span>
          )}
        </div>
      )}

      {/* ── Pool stats ─────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">Protocol stats</h2>
        {loading ? (
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="border border-zinc-800 rounded-xl p-5 bg-zinc-900/50 animate-pulse h-24" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : stats ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MetricCard
              label="Total deposits"
              value={stats.totalDeposits.toString()}
              sub="unique commitments (incl. dummies)"
            />
            <MetricCard
              label="TVL"
              value={parseFloat(formatEther(stats.tvlWei)).toFixed(4) + " ETH"}
              sub="in shielded pool"
            />
            <MetricCard
              label="Utilization"
              value={(stats.utilizationBps / 100).toFixed(1) + "%"}
              sub={parseFloat(formatEther(stats.activeBorrowsWei)).toFixed(4) + " ETH borrowed"}
            />
          </div>
        ) : null}
      </div>

      {/* ── Your notes ─────────────────────────────────────────────────────── */}
      {address && (
        <div>
          <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">Your notes</h2>
          {activeNotes.length === 0 && spentNotes.length === 0 ? (
            <div className="border border-zinc-800 rounded-xl p-6 text-center">
              <p className="text-sm text-zinc-500">
                {isUnlocked ? "No notes yet." : "Unlock vault to view notes."}
              </p>
              {isUnlocked && (
                <p className="text-xs text-zinc-600 mt-1">Make a deposit to receive a private note.</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {activeNotes.map((n) => (
                <div
                  key={n.nullifierHash}
                  className="border border-zinc-800 rounded-lg px-4 py-3 flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm text-zinc-200">{noteLabel(n)}</p>
                    <p className="text-xs text-zinc-600 font-mono mt-0.5">
                      {n.nullifierHash.slice(0, 10)}...{n.nullifierHash.slice(-6)}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full bg-green-900/40 text-green-400 border border-green-800">
                    Active
                  </span>
                </div>
              ))}
              {spentNotes.map((n) => (
                <div
                  key={n.nullifierHash}
                  className="border border-zinc-800/50 rounded-lg px-4 py-3 flex items-center justify-between opacity-50"
                >
                  <div>
                    <p className="text-sm text-zinc-400 line-through">{noteLabel(n)}</p>
                    <p className="text-xs text-zinc-700 font-mono mt-0.5">
                      {n.nullifierHash.slice(0, 10)}...{n.nullifierHash.slice(-6)}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full bg-zinc-900 text-zinc-600 border border-zinc-800">
                    Spent
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Active loans ─────────────────────────────────────────────────── */}
      {address && userLoans.length > 0 && (
        <div>
          <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">Active loans</h2>
          <div className="space-y-2">
            {userLoans.map((loan) => (
              <div
                key={loan.loanId}
                className="border border-zinc-800 rounded-lg px-4 py-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm text-zinc-200 font-medium">Loan #{loan.loanId}</p>
                  <span className="text-xs text-zinc-500 font-mono">
                    {parseFloat(formatEther(loan.borrowed)).toFixed(4)} ETH borrowed
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span>
                    Total owed:{" "}
                    <span className="text-zinc-300 font-mono">
                      {parseFloat(formatEther(loan.totalOwed)).toFixed(6)} ETH
                    </span>
                  </span>
                  <span>
                    Interest:{" "}
                    <span className="text-amber-400 font-mono">
                      {parseFloat(formatEther(loan.totalOwed - loan.borrowed)).toFixed(6)} ETH
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Privacy notice ──────────────────────────────────────────────────── */}
      <div className="border border-zinc-800/50 rounded-lg p-4 text-xs text-zinc-600">
        <strong className="text-zinc-500">Privacy model V2:</strong> Notes are encrypted with
        AES-256-GCM in localStorage using a key derived from your wallet signature. Pool balances
        cannot be attributed to individual addresses on-chain. Epoch batching + dummy insertions
        ensure a minimum anonymity set of 300+ even at protocol launch.
      </div>
    </div>
  );
}
