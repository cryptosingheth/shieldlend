"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { SHIELDED_POOL_ADDRESS, SHIELDED_POOL_ABI, LENDING_POOL_ADDRESS, LENDING_POOL_ABI } from "@/lib/contracts";
import { loadNotes, noteLabel, type StoredNote } from "@/lib/noteStorage";
import { useLoanDetails } from "@/lib/contracts";

const DEPLOY_BLOCK = 39499000n;
const CHUNK_SIZE = 9000n;

async function getAllLogs(
  publicClient: ReturnType<typeof usePublicClient>,
  address: `0x${string}`
) {
  if (!publicClient) return [];
  const latest = await publicClient.getBlockNumber();
  const allLogs = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK_SIZE) {
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
  utilizationBps: number; // basis points
}

interface UserLoan {
  loanId: number;
  borrowed: bigint;
  totalOwed: bigint;
  repaid: boolean;
}

// Health factor color
function hfColor(hf: number): string {
  if (hf >= 2.0) return "text-green-400";
  if (hf >= 1.5) return "text-amber-400";
  return "text-red-400";
}

// Metric card component
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

  const [stats, setStats] = useState<PoolStats | null>(null);
  const [userLoans, setUserLoans] = useState<UserLoan[]>([]);
  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (address) setSavedNotes(loadNotes(address));
  }, [address]);

  useEffect(() => {
    if (!publicClient) return;

    async function fetchStats() {
      try {
        setLoading(true);

        // Deposit count
        const nextIndex = await publicClient!.readContract({
          address: SHIELDED_POOL_ADDRESS,
          abi: SHIELDED_POOL_ABI,
          functionName: "nextIndex",
        }) as number;

        // Deposit events → aggregate TVL
        const depositLogs = await getAllLogs(publicClient!, SHIELDED_POOL_ADDRESS);
        let tvl = 0n;
        for (const log of depositLogs) {
          // Deposit event: (bytes32 commitment, uint32 leafIndex, uint256 timestamp, uint256 amount)
          if (log.topics.length >= 2 && log.data.length >= 130) {
            // amount is the 4th field in data (3rd uint256 after leafIndex and timestamp)
            // data layout: leafIndex(32) + timestamp(32) + amount(32)
            const amountHex = log.data.slice(130, 194);
            if (amountHex.length === 64) {
              tvl += BigInt("0x" + amountHex);
            }
          }
        }

        // Borrowed events → aggregate active borrows (rough — doesn't subtract repaid)
        const borrowLogs = await getAllLogs(publicClient!, LENDING_POOL_ADDRESS);
        let totalBorrowed = 0n;
        const loanIds: number[] = [];
        for (const log of borrowLogs) {
          if (log.topics.length >= 2 && log.data.length >= 130) {
            const amountHex = log.data.slice(66, 130);
            if (amountHex.length === 64) totalBorrowed += BigInt("0x" + amountHex);
            const loanId = parseInt(log.topics[1] as string, 16);
            if (!isNaN(loanId)) loanIds.push(loanId);
          }
        }

        const utilizationBps =
          tvl > 0n ? Number((totalBorrowed * 10000n) / tvl) : 0;

        setStats({
          totalDeposits: Number(nextIndex),
          tvlWei: tvl,
          activeBorrowsWei: totalBorrowed,
          utilizationBps,
        });

        // User's loans — filter Borrowed events by recipient (topics[3] or data)
        if (address && loanIds.length > 0) {
          const details: UserLoan[] = [];
          for (const id of loanIds.slice(-20)) { // last 20 loans
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
            } catch {
              // loan may not exist or belong to someone else
            }
          }
          setUserLoans(details);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load stats");
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, [publicClient, address]);

  const activeNotes = savedNotes.filter((n) => !n.spent);
  const spentNotes = savedNotes.filter((n) => n.spent);

  return (
    <div className="space-y-8">
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
              sub="unique commitments"
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
              <p className="text-sm text-zinc-500">No notes yet.</p>
              <p className="text-xs text-zinc-600 mt-1">
                Make a deposit to receive a private note.
              </p>
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

      {/* ── Active loans ────────────────────────────────────────────────────── */}
      {address && userLoans.length > 0 && (
        <div>
          <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">Active loans</h2>
          <div className="space-y-2">
            {userLoans.map((loan) => {
              // Health factor: assume collateral is stored in notes — use best available estimate
              const hf = 0; // actual health factor requires knowing which note was used
              return (
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
              );
            })}
          </div>
        </div>
      )}

      {/* ── Privacy notice ──────────────────────────────────────────────────── */}
      <div className="border border-zinc-800/50 rounded-lg p-4 text-xs text-zinc-600">
        <strong className="text-zinc-500">Privacy model:</strong> Deposit notes are stored only in
        your browser. Pool balances cannot be attributed to individual addresses on-chain. Your
        notes are saved in localStorage (unencrypted) — for testnet demo use only.
      </div>
    </div>
  );
}
