"use client";

import { useState, useEffect } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { type Address, type Log } from "viem";
import { useWithdraw } from "@/lib/contracts";
import {
  deserializeNote,
  generateWithdrawProof,
  type MerklePath,
} from "@/lib/circuits";
import { SHIELDED_POOL_ADDRESS, SHIELDED_POOL_ABI, fieldToBytes32 } from "@/lib/contracts";
import { loadNotes, markNoteSpent, storedNoteToNote, noteLabel, type StoredNote } from "@/lib/noteStorage";

// ShieldedPool was deployed at this block — avoids querying from genesis
const DEPLOY_BLOCK = 39499000n;
const CHUNK_SIZE = 9000n;

// Fetch all logs in chunks to stay within RPC's 10,000-block getLogs limit
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

  // Saved notes from vault
  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [selectedNullifierHash, setSelectedNullifierHash] = useState<string>("");

  useEffect(() => {
    if (address) setSavedNotes(loadNotes(address).filter((n) => !n.spent));
  }, [address]);

  const [noteJson, setNoteJson] = useState("");
  const [recipient, setRecipient] = useState(address ?? "");
  const [status, setStatus] = useState<
    "idle" | "fetching-path" | "proving" | "zkverify" | "submitting" | "done" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const { withdraw, isPending, isConfirming, isSuccess } = useWithdraw();

  async function fetchMerklePath(leafIndex: number, root: `0x${string}`): Promise<MerklePath> {
    if (!publicClient) throw new Error("No public client");

    const logs = await getAllLogs(publicClient, SHIELDED_POOL_ADDRESS);

    // Build sparse commitments map: leafIndex → commitment value
    const commitMap = new Map<number, bigint>();
    for (const log of logs) {
      if (log.topics.length < 2) continue;
      const commitment = log.topics[1] as `0x${string}`;
      const idx = parseInt(log.data.slice(2, 66), 16);
      commitMap.set(idx, BigInt(commitment));
    }

    const { buildPoseidon } = await import("circomlibjs");
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const LEVELS = 20;

    // Precompute zero hashes for each level — O(20) instead of O(2^20)
    // zeros[0] = empty leaf, zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
    const zeros: bigint[] = [0n];
    for (let i = 0; i < LEVELS; i++) {
      zeros.push(F.toObject(poseidon([zeros[i], zeros[i]])) as bigint);
    }

    // Sparse path computation — only compute nodes along the proof path
    // At each level, track only the non-zero nodes needed to compute siblings
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentLevel = new Map<number, bigint>(commitMap);

    let idx = leafIndex;
    for (let level = 0; level < LEVELS; level++) {
      const isRight = idx % 2;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      // Sibling is either a known non-zero node or a zero subtree
      pathElements.push(currentLevel.get(siblingIdx) ?? zeros[level]);
      pathIndices.push(isRight);

      // Compute parent level — only for non-zero nodes
      const nextLevel = new Map<number, bigint>();
      for (const [nodeIdx, val] of currentLevel) {
        const parentIdx = Math.floor(nodeIdx / 2);
        if (nextLevel.has(parentIdx)) continue; // already computed from sibling
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
    const hasSelectedNote = !!selectedNullifierHash;
    if (!hasSelectedNote && !noteJson.trim()) return setErrorMsg("Select a note or paste JSON");
    if (!recipient) return setErrorMsg("Enter recipient address");

    try {
      setErrorMsg("");
      setStatus("fetching-path");

      const selectedStored = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);
      const note = selectedStored ? storedNoteToNote(selectedStored) : deserializeNote(noteJson);
      if (!publicClient) throw new Error("No public client");

      // Get current root and leaf index from on-chain events
      const currentRoot = (await publicClient.readContract({
        address: SHIELDED_POOL_ADDRESS,
        abi: SHIELDED_POOL_ABI,
        functionName: "getLastRoot",
      })) as `0x${string}`;

      // Get deposit event for this note to find leafIndex
      const logs = await getAllLogs(publicClient, SHIELDED_POOL_ADDRESS);

      const noteCommitment = fieldToBytes32(note.commitment);
      const depositLog = logs.find((l) =>
        l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
      );
      if (!depositLog) throw new Error("Note not found on-chain. Was it deposited?");

      const leafIndex = parseInt(depositLog.data.slice(2, 66), 16);
      const merklePath = await fetchMerklePath(leafIndex, currentRoot);

      setStatus("proving");
      const { proof, publicSignals } = await generateWithdrawProof(note, merklePath, recipient);

      setStatus("zkverify");
      // Submit to zkVerify API route (server-side — keeps seed phrase off client)
      const zkRes = await fetch("/api/zkverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circuit: "withdraw", proof, publicSignals }),
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
      // Mark note as spent in vault so it won't appear in future dropdowns
      if (address && (selectedNullifierHash || fieldToBytes32(note.nullifierHash))) {
        markNoteSpent(address, selectedNullifierHash || fieldToBytes32(note.nullifierHash));
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
    proving: "Generating ZK proof (~20s)...",
    zkverify: "Submitting to zkVerify...",
    submitting: "Confirm in wallet...",
    done: "Withdrawn",
    error: "Withdraw",
  };

  const isLoading =
    status !== "idle" && status !== "done" && status !== "error" &&
    (["fetching-path", "proving", "zkverify", "submitting"].includes(status) ||
    isPending ||
    isConfirming);

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
          Send to any address — it won't be linked to your deposit
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
