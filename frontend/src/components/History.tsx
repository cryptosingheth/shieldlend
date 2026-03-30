"use client";

import { useEffect, useState } from "react";
import { formatEther, type Log } from "viem";
import { usePublicClient } from "wagmi";
import { SHIELDED_POOL_ADDRESS, LENDING_POOL_ADDRESS } from "@/lib/contracts";

type RawLog = Log & { txHash: `0x${string}` | null };

const DEPLOY_BLOCK = 39499000n;
const CHUNK_SIZE = 9000n;

async function getAllLogs(
  publicClient: ReturnType<typeof usePublicClient>,
  address: `0x${string}`
): Promise<RawLog[]> {
  if (!publicClient) return [];
  const latest = await publicClient.getBlockNumber();
  const allLogs: RawLog[] = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK_SIZE) {
    const to = from + CHUNK_SIZE - 1n < latest ? from + CHUNK_SIZE - 1n : latest;
    const chunk = await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
    allLogs.push(...(chunk as RawLog[]));
  }
  return allLogs;
}

type EventType = "deposit" | "withdrawal" | "borrow" | "repay";

interface ProtocolEvent {
  type: EventType;
  txHash: string;
  blockNumber: bigint;
  amount?: bigint;
  shortId: string; // first 8 chars of relevant hash (commitment or nullifierHash)
}

const EVENT_LABELS: Record<EventType, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  borrow: "Borrow",
  repay: "Repay",
};

const EVENT_COLORS: Record<EventType, string> = {
  deposit: "bg-indigo-900/40 text-indigo-400 border-indigo-800",
  withdrawal: "bg-green-900/40 text-green-400 border-green-800",
  borrow: "bg-amber-900/40 text-amber-400 border-amber-800",
  repay: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

export function History() {
  const publicClient = usePublicClient();
  const [events, setEvents] = useState<ProtocolEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!publicClient) return;

    async function fetchHistory() {
      try {
        setLoading(true);
        const collected: ProtocolEvent[] = [];

        // ── Deposit events ─────────────────────────────────────────────────
        const depositLogs = await getAllLogs(publicClient!, SHIELDED_POOL_ADDRESS);
        for (const log of depositLogs) {
          if (!log.txHash) continue;
          // Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp, uint256 amount)
          const commitment = log.topics[1] as string ?? "";
          let amount: bigint | undefined;
          if (log.data.length >= 194) {
            try { amount = BigInt("0x" + log.data.slice(130, 194)); } catch {}
          }
          collected.push({
            type: "deposit",
            txHash: log.txHash,
            blockNumber: log.blockNumber ?? 0n,
            amount,
            shortId: commitment.slice(0, 10),
          });
        }

        // ── Withdrawal events ──────────────────────────────────────────────
        // Withdrawal(address indexed recipient, bytes32 nullifierHash, uint256 amount)
        for (const log of depositLogs) {
          // Withdrawals come from same ShieldedPool address but different topic[0]
          // We already fetched pool logs — separate by checking data length
          // (Withdrawal has 2 data fields, Deposit has 3)
          // Actually: both come from the same getLogs call — filter by topic count
          if (log.topics.length === 2 && log.data.length >= 130) {
            // Could be a withdrawal: recipient indexed, nullifierHash + amount in data
            try {
              const amount = BigInt("0x" + log.data.slice(66, 130));
              collected.push({
                type: "withdrawal",
                txHash: log.txHash!,
                blockNumber: log.blockNumber ?? 0n,
                amount,
                shortId: (log.topics[1] as string ?? "").slice(0, 10),
              });
            } catch {}
          }
        }

        // ── Borrow events ──────────────────────────────────────────────────
        const borrowLogs = await getAllLogs(publicClient!, LENDING_POOL_ADDRESS);
        // Borrowed(uint256 indexed loanId, bytes32 indexed collateralNullifierHash, uint256 amount, address recipient)
        for (const log of borrowLogs) {
          if (!log.txHash || log.topics.length < 3) continue;
          let amount: bigint | undefined;
          if (log.data.length >= 66) {
            try { amount = BigInt("0x" + log.data.slice(2, 66)); } catch {}
          }
          collected.push({
            type: "borrow",
            txHash: log.txHash,
            blockNumber: log.blockNumber ?? 0n,
            amount,
            shortId: (log.topics[1] as string ?? "").slice(0, 10),
          });
        }

        // Sort by block descending (newest first), take last 30
        collected.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1));
        setEvents(collected.slice(0, 30));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load history");
      } finally {
        setLoading(false);
      }
    }

    fetchHistory();
  }, [publicClient]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="border border-zinc-800 rounded-lg px-4 py-3 animate-pulse h-14" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>;
  }

  if (events.length === 0) {
    return (
      <div className="border border-zinc-800 rounded-xl p-8 text-center">
        <p className="text-sm text-zinc-500">No protocol activity yet.</p>
        <p className="text-xs text-zinc-600 mt-1">
          Deposits and withdrawals on Base Sepolia will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-600 mb-4">
        Showing last {events.length} protocol events on Base Sepolia.
        Amounts are public; identities are not linked.
      </p>
      {events.map((event, i) => (
        <div
          key={event.txHash + i}
          className="border border-zinc-800 rounded-lg px-4 py-3 flex items-center justify-between hover:bg-zinc-900/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span
              className={`text-xs px-2 py-0.5 rounded-full border font-medium ${EVENT_COLORS[event.type]}`}
            >
              {EVENT_LABELS[event.type]}
            </span>
            <span className="text-xs text-zinc-500 font-mono">{event.shortId}...</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-right">
            {event.amount !== undefined && (
              <span className="text-zinc-300 font-mono">
                {parseFloat(formatEther(event.amount)).toFixed(4)} ETH
              </span>
            )}
            <span className="text-zinc-600 font-mono">
              block {event.blockNumber.toString()}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
