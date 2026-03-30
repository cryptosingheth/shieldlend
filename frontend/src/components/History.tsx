"use client";

import { useEffect, useState } from "react";
import { formatEther, type Log } from "viem";
import { usePublicClient } from "wagmi";
import { SHIELDED_POOL_ADDRESS, LENDING_POOL_ADDRESS } from "@/lib/contracts";

// ─── Event topic0 hashes (keccak256 of canonical signature) ──────────────────
// cast sig-event "Deposit(bytes32,uint32,uint256,uint256)"
const TOPIC_DEPOSIT     = "0x5371f021da83c329fcf7058e2039d7c7384459a19a13baed1a0d9efbfb9d0ee6";
// cast sig-event "Withdrawal(address,bytes32,uint256)"
const TOPIC_WITHDRAWAL  = "0x4206db6775563d1043abfcf27cd0ecd19fcc464be574a1487fc95b24957a671a";
// cast sig-event "Borrowed(uint256,bytes32,uint256,address)"
const TOPIC_BORROWED    = "0xfee8aa84475025b266c50fc8a54f76b49eddc5d7b92c0061e9251acdbf2a11e7";
// cast sig-event "Repaid(uint256,uint256)"
const TOPIC_REPAID      = "0x81472a96709c8315c82af40d41ef624a642ad53864b097e53af675593bb4e035";

type RawLog = Log & { txHash: `0x${string}` | null };

const DEPLOY_BLOCK = 39499000n;
const CHUNK_SIZE = 9000n;

async function getAllLogs(
  publicClient: ReturnType<typeof usePublicClient>,
  address: `0x${string}`
): Promise<RawLog[]> {
  if (!publicClient) return [];
  const latest = await publicClient.getBlockNumber();
  const all: RawLog[] = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK_SIZE) {
    const to = from + CHUNK_SIZE - 1n < latest ? from + CHUNK_SIZE - 1n : latest;
    const chunk = await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
    all.push(...(chunk as RawLog[]));
  }
  return all;
}

// Read a uint256 from a specific 32-byte slot in log.data (0-indexed)
function readUint(data: string, slotIndex: number): bigint {
  const start = 2 + slotIndex * 64; // skip 0x prefix
  const hex = data.slice(start, start + 64);
  return hex.length === 64 ? BigInt("0x" + hex) : 0n;
}

type EventType = "deposit" | "withdrawal" | "borrow" | "repay";

interface ProtocolEvent {
  type: EventType;
  txHash: string;
  blockNumber: bigint;
  amount?: bigint;
  shortId: string;
}

const EVENT_LABELS: Record<EventType, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  borrow: "Borrow",
  repay: "Repay",
};

const EVENT_COLORS: Record<EventType, string> = {
  deposit:    "bg-indigo-900/40 text-indigo-400 border-indigo-800",
  withdrawal: "bg-green-900/40 text-green-400 border-green-800",
  borrow:     "bg-amber-900/40 text-amber-400 border-amber-800",
  repay:      "bg-zinc-800 text-zinc-400 border-zinc-700",
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

        // ── ShieldedPool logs ──────────────────────────────────────────────
        const poolLogs = await getAllLogs(publicClient!, SHIELDED_POOL_ADDRESS);
        for (const log of poolLogs) {
          const t0 = log.topics[0] as string;

          if (t0 === TOPIC_DEPOSIT) {
            // Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp, uint256 amount)
            // data: [leafIndex(uint32 padded), timestamp(uint256), amount(uint256)] — 3 slots
            const amount = readUint(log.data, 2); // slot 2 = amount
            collected.push({
              type: "deposit",
              txHash: log.txHash ?? "",
              blockNumber: log.blockNumber ?? 0n,
              amount,
              shortId: (log.topics[1] as string ?? "").slice(0, 10),
            });
          } else if (t0 === TOPIC_WITHDRAWAL) {
            // Withdrawal(address indexed recipient, bytes32 nullifierHash, uint256 amount)
            // data: [nullifierHash(bytes32), amount(uint256)] — 2 slots
            const amount = readUint(log.data, 1); // slot 1 = amount
            collected.push({
              type: "withdrawal",
              txHash: log.txHash ?? "",
              blockNumber: log.blockNumber ?? 0n,
              amount,
              shortId: (log.topics[1] as string ?? "").slice(0, 10),
            });
          }
        }

        // ── LendingPool logs ───────────────────────────────────────────────
        const lendingLogs = await getAllLogs(publicClient!, LENDING_POOL_ADDRESS);
        for (const log of lendingLogs) {
          const t0 = log.topics[0] as string;

          if (t0 === TOPIC_BORROWED) {
            // Borrowed(uint256 indexed loanId, bytes32 indexed collateralNullifierHash, uint256 amount, address recipient)
            // data: [amount(uint256), recipient(address padded)] — 2 slots
            const amount = readUint(log.data, 0);
            collected.push({
              type: "borrow",
              txHash: log.txHash ?? "",
              blockNumber: log.blockNumber ?? 0n,
              amount,
              shortId: (log.topics[1] as string ?? "").slice(0, 10),
            });
          } else if (t0 === TOPIC_REPAID) {
            // Repaid(uint256 indexed loanId, uint256 totalRepaid)
            // data: [totalRepaid(uint256)] — 1 slot
            const amount = readUint(log.data, 0);
            collected.push({
              type: "repay",
              txHash: log.txHash ?? "",
              blockNumber: log.blockNumber ?? 0n,
              amount,
              shortId: (log.topics[1] as string ?? "").slice(0, 10),
            });
          }
        }

        // Newest first, cap at 50
        collected.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1));
        setEvents(collected.slice(0, 50));
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
        {[...Array(5)].map((_, i) => (
          <div key={i} className="border border-zinc-800 rounded-lg px-4 py-3 animate-pulse h-14" />
        ))}
      </div>
    );
  }

  if (error) return <p className="text-sm text-red-400">{error}</p>;

  if (events.length === 0) {
    return (
      <div className="border border-zinc-800 rounded-xl p-8 text-center">
        <p className="text-sm text-zinc-500">No protocol activity yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-600 mb-4">
        {events.length} protocol events on Base Sepolia. Click any row to view on BaseScan.
      </p>
      {events.map((event, i) => (
        <a
          key={event.txHash + i}
          href={`https://sepolia.basescan.org/tx/${event.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-zinc-800 rounded-lg px-4 py-3 flex items-center justify-between
                     hover:bg-zinc-900/70 hover:border-zinc-700 transition-colors cursor-pointer block"
        >
          <div className="flex items-center gap-3">
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${EVENT_COLORS[event.type]}`}>
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
            <span className="text-zinc-600 font-mono hidden sm:inline">
              block {event.blockNumber.toString()}
            </span>
            <span className="text-zinc-700 text-xs">↗</span>
          </div>
        </a>
      ))}
    </div>
  );
}
