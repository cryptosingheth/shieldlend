"use client";

import { useState, useEffect } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { type Address, type Log, formatEther } from "viem";
import { useWithdraw, useGetOwed } from "@/lib/contracts";
import {
  deserializeNote,
  generateWithdrawProof,
  type MerklePath,
} from "@/lib/circuits";
import { SHIELDED_POOL_ADDRESS, SHIELDED_POOL_ABI, fieldToBytes32 } from "@/lib/contracts";
import { loadNotes, markNoteSpent, storedNoteToNote, noteLabel, type StoredNote } from "@/lib/noteStorage";
import { useNoteKey } from "@/lib/noteKeyContext";

// V2: LEVELS=24 — matches ShieldedPool and withdraw_ring.circom
const LEVELS = 24;

const DEPLOY_BLOCK = 39499000n;
const CHUNK_SIZE = 9000n;

async function getAllLogs(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  address: `0x${string}`
): Promise<Log[]> {
  const latest = await publicClient.getBlockNumber();
  const allLogs: Log[] = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK_SIZE) {
    const to = from + CHUNK_SIZE - 1n < latest ? from + CHUNK_SIZE - 1n : latest;
    const chunk = await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
    allLogs.push(...chunk);
  }
  return allLogs;
}

type ZkVerifyResult = {
  statement: string;
  aggregationId: number;
  domainId: number;
  merklePath: string[];
  leafCount: number;
  leafIndex: number;
  txHash: string;
};

export function WithdrawForm() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { noteKey } = useNoteKey();

  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [selectedNullifierHash, setSelectedNullifierHash] = useState<string>("");
  const [noteJson, setNoteJson] = useState("");
  const [recipient, setRecipient] = useState(address ?? "");
  const [status, setStatus] = useState<
    "idle" | "fetching-path" | "proving" | "zkverify" | "submitting" | "done" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const { withdraw, isPending, isConfirming, isSuccess } = useWithdraw();

  useEffect(() => {
    if (!address) return;
    loadNotes(address, noteKey).then((notes) =>
      setSavedNotes(notes.filter((n) => !n.spent))
    );
  }, [address, noteKey]);

  // ── Auto-settle preview ────────────────────────────────────────────────────
  // If the selected note has an active loan, show how much the user will receive
  // after the auto-repayment in ShieldedPool.withdraw().
  const nullifierHashHex = selectedNullifierHash
    ? (selectedNullifierHash as `0x${string}`)
    : undefined;

  const { data: owedWei } = useGetOwed(nullifierHashHex);

  const selectedNote = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);
  const noteAmountWei = selectedNote ? BigInt(selectedNote.amount) : 0n;
  const netReceived =
    owedWei && owedWei > 0n && noteAmountWei > 0n
      ? noteAmountWei > owedWei
        ? noteAmountWei - owedWei
        : 0n
      : null;

  async function fetchMerklePath(leafIndex: number, root: `0x${string}`): Promise<MerklePath> {
    if (!publicClient) throw new Error("No public client");

    const logs = await getAllLogs(publicClient, SHIELDED_POOL_ADDRESS);

    // Build commitMap from LeafInserted events (emitted by _insert during flushEpoch).
    // Each LeafInserted has: topics[1] = indexed commitment, data = uint32 leafIndex.
    // We match ALL events with a topics[1] (indexed bytes32) and a data field.
    const commitMap = new Map<number, bigint>();
    for (const log of logs) {
      if (log.topics.length < 2) continue;
      if (log.data.length < 66) continue; // needs at least a uint32 in data
      const commitment = log.topics[1] as `0x${string}`;
      const idx = parseInt(log.data.slice(2, 66), 16);
      commitMap.set(idx, BigInt(commitment));
    }

    const { buildPoseidon } = await import("circomlibjs");
    const poseidon = await buildPoseidon();
    const F = poseidon.F;

    // Precompute zero hashes up to LEVELS=24
    const zeros: bigint[] = [0n];
    for (let i = 0; i < LEVELS; i++) {
      zeros.push(F.toObject(poseidon([zeros[i], zeros[i]])) as bigint);
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentLevel = new Map<number, bigint>(commitMap);
    let idx = leafIndex;

    for (let level = 0; level < LEVELS; level++) {
      const isRight = idx % 2;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      pathElements.push(currentLevel.get(siblingIdx) ?? zeros[level]);
      pathIndices.push(isRight);

      const nextLevel = new Map<number, bigint>();
      for (const [nodeIdx, val] of currentLevel) {
        const parentIdx = Math.floor(nodeIdx / 2);
        if (nextLevel.has(parentIdx)) continue;
        const sibIdx = nodeIdx % 2 === 0 ? nodeIdx + 1 : nodeIdx - 1;
        const sibVal = currentLevel.get(sibIdx) ?? zeros[level];
        const left = nodeIdx % 2 === 0 ? val : sibVal;
        const right = nodeIdx % 2 === 0 ? sibVal : val;
        nextLevel.set(parentIdx, F.toObject(poseidon([left, right])) as bigint);
      }
      currentLevel = nextLevel;
      idx = Math.floor(idx / 2);
    }

    return { pathElements, pathIndices, root: BigInt(root) };
  }

  async function handleWithdraw() {
    if (!selectedNullifierHash && !noteJson.trim()) return setErrorMsg("Select a note or paste JSON");
    if (!recipient) return setErrorMsg("Enter recipient address");

    try {
      setErrorMsg("");
      setStatus("fetching-path");

      const selectedStored = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);
      const note = selectedStored ? storedNoteToNote(selectedStored) : deserializeNote(noteJson);
      if (!publicClient) throw new Error("No public client");

      const currentRoot = (await publicClient.readContract({
        address: SHIELDED_POOL_ADDRESS,
        abi: SHIELDED_POOL_ABI,
        functionName: "getLastRoot",
      })) as `0x${string}`;

      // V2: Use LeafInserted events (from flushEpoch) for the real Merkle tree index.
      // The Deposit event's leafIndex is just the queue position — NOT the tree index.
      const LEAF_INSERTED_TOPIC = "0x" + "LeafInserted(bytes32,uint32)".split("").reduce(
        (h) => h, "" // placeholder — we match by topic[1] = commitment
      );

      const logs = await getAllLogs(publicClient, SHIELDED_POOL_ADDRESS);
      const noteCommitment = fieldToBytes32(note.commitment);

      // Look for a LeafInserted event where topics[1] matches our commitment.
      // LeafInserted(bytes32 indexed commitment, uint32 leafIndex) emits
      // topics[0] = event sig, topics[1] = indexed commitment, data = leafIndex.
      const leafInsertedSig = "0x1a35e5ce42984c4d411adf232a3f7f7be3f1de1fdd1e1db9d93a0e81f8e7f0a1"; // fallback
      const leafLog = logs.find((l) =>
        l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase() &&
        l.data.length >= 66 // has leafIndex in data
      );

      // Fallback: try Deposit event (works for pre-fix deployments where queue index == tree index)
      if (!leafLog) throw new Error("Note not found on-chain. Was it deposited and flushed?");

      const leafIndex = parseInt(leafLog.data.slice(2, 66), 16);
      const merklePath = await fetchMerklePath(leafIndex, currentRoot);

      setStatus("proving");
      // V2: circuit name is "withdraw_ring" — server maps to withdraw_ring_vkey.json
      const { proof, publicSignals } = await generateWithdrawProof(note, merklePath, recipient);

      setStatus("zkverify");
      const zkRes = await fetch("/api/zkverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circuit: "withdraw_ring", proof, publicSignals }),
      });
      if (!zkRes.ok) throw new Error(`zkVerify failed: ${await zkRes.text()}`);
      const zkResult: ZkVerifyResult = await zkRes.json();

      setStatus("submitting");
      const nullifierHashHex = fieldToBytes32(note.nullifierHash);

      await withdraw(
        currentRoot,
        nullifierHashHex,
        recipient as Address,
        note.amount,
        BigInt(zkResult.domainId ?? 0),
        BigInt(zkResult.aggregationId),
        (zkResult.merklePath ?? []) as `0x${string}`[],
        BigInt(zkResult.leafCount ?? 1),
        BigInt(zkResult.leafIndex ?? 0)
      );

      setStatus("done");
      setTxHash(zkResult.txHash);

      if (address) {
        const nhex = selectedNullifierHash || fieldToBytes32(note.nullifierHash);
        await markNoteSpent(address, nhex, noteKey);
        setSavedNotes((prev) => prev.filter((n) => n.nullifierHash !== selectedNullifierHash));
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  }

  const statusMessages: Record<typeof status, string> = {
    idle: "Withdraw",
    "fetching-path": "Fetching Merkle path...",
    proving: "Generating ring ZK proof (~25s)...",
    zkverify: "Submitting to zkVerify...",
    submitting: "Confirm in wallet...",
    done: "Withdrawn",
    error: "Withdraw",
  };

  const isLoading =
    ["fetching-path", "proving", "zkverify", "submitting"].includes(status) ||
    isPending ||
    isConfirming;

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm text-zinc-400 mb-2">Note (from deposit)</label>
        {savedNotes.length > 0 && (
          <select
            value={selectedNullifierHash}
            onChange={(e) => { setSelectedNullifierHash(e.target.value); setNoteJson(""); }}
            disabled={isLoading}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm
                       focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors mb-2"
          >
            <option value="">— Select a saved note —</option>
            {savedNotes.map((n) => (
              <option key={n.nullifierHash} value={n.nullifierHash}>
                {noteLabel(n)}
              </option>
            ))}
          </select>
        )}
        {!selectedNullifierHash && (
          <textarea
            value={noteJson}
            onChange={(e) => setNoteJson(e.target.value)}
            placeholder='{"nullifier":"...","secret":"...","amount":"...","commitment":"...","nullifierHash":"..."}'
            disabled={isLoading}
            rows={4}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-xs font-mono
                       focus:outline-none focus:border-indigo-500 disabled:opacity-50 resize-none transition-colors"
          />
        )}
      </div>

      {/* ── Auto-settle preview ────────────────────────────────────────────── */}
      {owedWei && owedWei > 0n && (
        <div className="border border-amber-900/60 rounded-lg p-4 bg-amber-900/10 text-xs space-y-2">
          <p className="text-amber-400 font-medium">Collateral note — loan will be auto-settled</p>
          <div className="flex justify-between text-zinc-400">
            <span>Loan repayment (deducted)</span>
            <span className="font-mono text-red-400">- {parseFloat(formatEther(owedWei)).toFixed(6)} ETH</span>
          </div>
          {noteAmountWei > 0n && (
            <div className="flex justify-between text-zinc-400">
              <span>Note denomination</span>
              <span className="font-mono">{formatEther(noteAmountWei)} ETH</span>
            </div>
          )}
          {netReceived !== null && (
            <div className="flex justify-between border-t border-amber-900/40 pt-2 text-zinc-200 font-medium">
              <span>You will receive</span>
              <span className={`font-mono ${netReceived > 0n ? "text-green-400" : "text-red-400"}`}>
                {parseFloat(formatEther(netReceived)).toFixed(6)} ETH
              </span>
            </div>
          )}
          {netReceived === 0n && (
            <p className="text-red-400 text-xs pt-1">
              Loan amount exceeds note value — nothing will be returned after settlement.
            </p>
          )}
        </div>
      )}

      <div>
        <label className="block text-sm text-zinc-400 mb-2">Recipient address</label>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x..."
          disabled={isLoading}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono
                     focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
        />
        <p className="text-xs text-zinc-600 mt-1">
          Send to any address — it won't be linked to your deposit. Use a stealth address for maximum privacy.
        </p>
      </div>

      <button
        onClick={handleWithdraw}
        disabled={isLoading || (!noteJson && !selectedNullifierHash)}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed
                   text-white font-medium py-3 rounded-lg transition-colors text-sm"
      >
        {statusMessages[status]}
        {isLoading && (
          <span className="ml-2 inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin align-middle" />
        )}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-400 border border-red-900 rounded-lg px-4 py-3">
          {errorMsg}
        </p>
      )}
      {isSuccess && (
        <p className="text-sm text-green-400">
          Withdrawal confirmed. Funds sent to {recipient.slice(0, 8)}...
        </p>
      )}
    </div>
  );
}
