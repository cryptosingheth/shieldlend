"use client";

import { useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { type Address } from "viem";
import { useWithdraw } from "@/lib/contracts";
import {
  deserializeNote,
  generateWithdrawProof,
  fieldToBytes32,
  type MerklePath,
} from "@/lib/circuits";
import { SHIELDED_POOL_ADDRESS, SHIELDED_POOL_ABI } from "@/lib/contracts";

type ZkVerifyResult = {
  statement: string;
  aggregationId: number;
  statementPath: unknown;
  txHash: string;
};

export function WithdrawForm() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [noteJson, setNoteJson] = useState("");
  const [recipient, setRecipient] = useState(address ?? "");
  const [status, setStatus] = useState<
    "idle" | "fetching-path" | "proving" | "zkverify" | "submitting" | "done" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const { withdraw, isPending, isConfirming, isSuccess } = useWithdraw();

  async function fetchMerklePath(leafIndex: number, root: `0x${string}`): Promise<MerklePath> {
    // Reconstruct Merkle path by querying on-chain Deposit events
    // In production: use an indexer. Here we query events directly.
    if (!publicClient) throw new Error("No public client");

    const logs = await publicClient.getLogs({
      address: SHIELDED_POOL_ADDRESS,
      event: SHIELDED_POOL_ABI.find((x) => "name" in x && x.name === "Deposit") as never,
      fromBlock: 0n,
    });

    // Build commitments array from events (ordered by leafIndex)
    const commitments: `0x${string}`[] = [];
    for (const log of logs) {
      if (!log.args) continue;
      const args = log.args as { commitment: `0x${string}`; leafIndex: number };
      commitments[Number(args.leafIndex)] = args.commitment;
    }

    // Build Merkle path for the target leaf
    // In production: use a relayer/indexer API. This is a simplified version.
    const { buildPoseidon } = await import("circomlibjs");
    const poseidon = await buildPoseidon();
    const F = poseidon.F;

    const LEVELS = 20;
    const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

    // Fill in zeros for missing leaves
    const leaves: bigint[] = Array(2 ** LEVELS)
      .fill(0n)
      .map((_, i) => (commitments[i] ? BigInt(commitments[i]) : 0n));

    // Build tree bottom-up
    let nodes: bigint[][] = [leaves];
    for (let level = 0; level < LEVELS; level++) {
      const layer = nodes[level];
      const next: bigint[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = layer[i + 1] ?? 0n;
        next.push(F.toObject(poseidon([left, right])) as bigint);
      }
      nodes.push(next);
    }

    // Extract path for leafIndex
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let level = 0; level < LEVELS; level++) {
      const isRight = idx % 2;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      pathIndices.push(isRight);
      pathElements.push(nodes[level][siblingIdx] ?? 0n);
      idx = Math.floor(idx / 2);
    }

    return { pathElements, pathIndices, root: BigInt(root) };
  }

  async function handleWithdraw() {
    if (!noteJson.trim()) return setErrorMsg("Paste your note JSON");
    if (!recipient) return setErrorMsg("Enter recipient address");

    try {
      setErrorMsg("");
      setStatus("fetching-path");

      const note = deserializeNote(noteJson);
      if (!publicClient) throw new Error("No public client");

      // Get current root and leaf index from on-chain events
      const currentRoot = (await publicClient.readContract({
        address: SHIELDED_POOL_ADDRESS,
        abi: SHIELDED_POOL_ABI,
        functionName: "getLastRoot",
      })) as `0x${string}`;

      // Get deposit event for this note to find leafIndex
      const logs = await publicClient.getLogs({
        address: SHIELDED_POOL_ADDRESS,
        event: SHIELDED_POOL_ABI.find((x) => "name" in x && x.name === "Deposit") as never,
        fromBlock: 0n,
      });

      const noteCommitment = fieldToBytes32(note.commitment);
      const depositLog = logs.find((l) => {
        const args = l.args as { commitment: `0x${string}` };
        return args.commitment?.toLowerCase() === noteCommitment.toLowerCase();
      });
      if (!depositLog?.args) throw new Error("Note not found on-chain. Was it deposited?");

      const leafIndex = Number((depositLog.args as { leafIndex: number }).leafIndex);
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

      // statementPath encodes the aggregation proof for on-chain verification
      withdraw(
        "0x" as `0x${string}`, // proof bytes (zkVerify handles verification via statementPath)
        currentRoot,
        nullifierHashHex,
        recipient as Address,
        note.amount,
        BigInt(zkResult.aggregationId)
      );

      setTxHash(zkResult.txHash);
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
    ["fetching-path", "proving", "zkverify", "submitting"].includes(status) ||
    isPending ||
    isConfirming;

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm text-zinc-400 mb-2">Note (from deposit)</label>
        <textarea
          value={noteJson}
          onChange={(e) => setNoteJson(e.target.value)}
          placeholder='{"nullifier":"...","secret":"...","amount":"...","commitment":"...","nullifierHash":"..."}'
          disabled={isLoading}
          rows={4}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-xs font-mono
                     focus:outline-none focus:border-indigo-500 disabled:opacity-50 resize-none transition-colors"
        />
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
        disabled={isLoading || !noteJson}
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
