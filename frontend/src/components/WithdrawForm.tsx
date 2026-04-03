"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract, useBlockNumber } from "wagmi";
import { type Address, type Log, formatEther } from "viem";
import { useWithdraw, useGetOwed, useEpochStatus } from "@/lib/contracts";
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

// Updated to actual deployment block of the V2 contracts on Base Sepolia
const DEPLOY_BLOCK = 39731476n;
const CHUNK_SIZE = 9000n;

// keccak256("LeafInserted(bytes32,uint32)") — used to filter only flushEpoch events,
// not Deposit events (both have commitment as topics[1] so we must check topics[0])
const LEAF_INSERTED_TOPIC = "0xa4e4458df45cfeb7eebc696f262212e6721fac69466bfc59f43b6040425afce6";

async function getAllLogs(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  address: `0x${string}`,
  upToBlock?: bigint  // if provided, ensures logs include this block (avoids race after flush)
): Promise<Log[]> {
  const latest = upToBlock ?? await publicClient.getBlockNumber();
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

  const { lastEpochBlock, epochBlocks } = useEpochStatus();
  const { data: currentBlock } = useBlockNumber({ watch: true });

  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [selectedNullifierHash, setSelectedNullifierHash] = useState<string>("");
  const [noteJson, setNoteJson] = useState("");
  const [recipient, setRecipient] = useState(address ?? "");
  const [status, setStatus] = useState<
    "idle" | "flushing" | "fetching-path" | "proving" | "zkverify" | "submitting" | "done" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [pendingFlush, setPendingFlush] = useState(false);
  // "unknown" = not yet checked, "checking" = fetching logs, "pending" = queued not flushed, "ready" = in tree
  const [noteFlushStatus, setNoteFlushStatus] = useState<"unknown" | "checking" | "pending" | "ready">("unknown");
  const { withdraw, isPending, isConfirming, isSuccess } = useWithdraw();
  const { writeContractAsync } = useWriteContract();

  useEffect(() => {
    if (!address) return;
    loadNotes(address, noteKey).then((notes) =>
      setSavedNotes(notes.filter((n) => !n.spent))
    );
  }, [address, noteKey]);

  // ── Note flush status check ───────────────────────────────────────────────
  // When a note is selected, check whether it has been inserted into the
  // Merkle tree (LeafInserted event exists) or is still pending epoch flush.
  useEffect(() => {
    if (!selectedNullifierHash || !publicClient) {
      setNoteFlushStatus("unknown");
      return;
    }
    const note = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);
    if (!note) { setNoteFlushStatus("unknown"); return; }

    setNoteFlushStatus("checking");
    const commitment = ("0x" + note.commitment.padStart(64, "0")) as `0x${string}`;

    // Snapshot the current block number first, then query up to it.
    // This prevents a race where the latest block advances between
    // when we start the check and when getLogs executes.
    publicClient.getBlockNumber().then((snapshotBlock) =>
      getAllLogs(publicClient, SHIELDED_POOL_ADDRESS, snapshotBlock)
    ).then((logs) => {
      const flushed = logs.some(
        (l) =>
          l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
          l.topics[1]?.toLowerCase() === commitment.toLowerCase()
      );
      setNoteFlushStatus(flushed ? "ready" : "pending");
    }).catch(() => setNoteFlushStatus("unknown"));
  }, [selectedNullifierHash, savedNotes, publicClient]);

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

    // Build commitMap ONLY from LeafInserted events (topics[0] = LEAF_INSERTED_TOPIC).
    // Deposit events also have topics[1] = indexed commitment but their data encodes
    // (queue position, timestamp, amount) — NOT the final tree index after shuffle.
    // Filtering by topics[0] ensures we only read post-flush tree positions.
    const commitMap = new Map<number, bigint>();
    for (const log of logs) {
      if (log.topics[0]?.toLowerCase() !== LEAF_INSERTED_TOPIC) continue;
      if (log.topics.length < 2) continue;
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

      const logs = await getAllLogs(publicClient, SHIELDED_POOL_ADDRESS);
      const noteCommitment = fieldToBytes32(note.commitment);

      // Check if deposit exists on-chain at all (Deposit event, any topics[1] match)
      const depositLog = logs.find((l) =>
        l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
      );
      if (!depositLog) throw new Error("Deposit not found on-chain. Wrong network or address?");

      // Look specifically for LeafInserted (topics[0] = LEAF_INSERTED_TOPIC).
      // Deposit events also have topics[1] = commitment but store queue position, not tree index.
      const leafLog = logs.find((l) =>
        l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
        l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
      );

      let resolvedLeafLog = leafLog;

      if (!resolvedLeafLog) {
        // Deposit is queued. Check whether the epoch is ready to flush.
        const lastEpochBlockOnChain = await publicClient.readContract({
          address: SHIELDED_POOL_ADDRESS,
          abi: SHIELDED_POOL_ABI,
          functionName: "lastEpochBlock",
        }) as bigint;
        const epochBlocksOnChain = await publicClient.readContract({
          address: SHIELDED_POOL_ADDRESS,
          abi: SHIELDED_POOL_ABI,
          functionName: "EPOCH_BLOCKS",
        }) as bigint;
        const blockNow = await publicClient.getBlockNumber();
        const blocksLeft = Number(lastEpochBlockOnChain + epochBlocksOnChain) - Number(blockNow);

        if (blocksLeft > 0) {
          throw new Error(
            `Deposit is queued — epoch flushes in ~${blocksLeft} blocks (~${blocksLeft * 2}s). Come back then.`
          );
        }

        // Epoch is ready. Auto-flush — user confirms one MetaMask tx, then proof continues.
        setStatus("flushing");
        const flushTxHash = await writeContractAsync({
          address: SHIELDED_POOL_ADDRESS,
          abi: SHIELDED_POOL_ABI,
          functionName: "flushEpoch",
        });

        // Wait for the flush receipt so we know the exact block it landed in.
        // getAllLogs must query UP TO that block — otherwise it may miss the
        // LeafInserted event if the node hasn't indexed the new block yet.
        const flushReceipt = await publicClient.waitForTransactionReceipt({ hash: flushTxHash });

        setStatus("fetching-path");
        const freshLogs = await getAllLogs(publicClient, SHIELDED_POOL_ADDRESS, flushReceipt.blockNumber);
        resolvedLeafLog = freshLogs.find((l) =>
          l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
          l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
        ) ?? null;

        if (!resolvedLeafLog) throw new Error("Flush succeeded but LeafInserted event not found. Try withdrawing again.");
        setNoteFlushStatus("ready");
        setPendingFlush(false);
      }

      const leafIndex = parseInt(resolvedLeafLog.data.slice(2, 66), 16);

      // Fetch fresh root after potential flush
      const freshRoot = (await publicClient.readContract({
        address: SHIELDED_POOL_ADDRESS,
        abi: SHIELDED_POOL_ABI,
        functionName: "getLastRoot",
      })) as `0x${string}`;

      const merklePath = await fetchMerklePath(leafIndex, freshRoot);

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
    flushing: "Inserting into Merkle tree...",
    "fetching-path": "Fetching Merkle path...",
    proving: "Generating ring ZK proof (~25s)...",
    zkverify: "Submitting to zkVerify...",
    submitting: "Confirm in wallet...",
    done: "Withdrawn",
    error: "Withdraw",
  };

  const isLoading =
    ["flushing", "fetching-path", "proving", "zkverify", "submitting"].includes(status) ||
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

      {/* Pending epoch banner — countdown only, no manual action needed */}
      {noteFlushStatus === "pending" && (() => {
        const flushAtBlock =
          lastEpochBlock !== undefined && epochBlocks !== undefined
            ? lastEpochBlock + epochBlocks
            : undefined;
        const blocksLeft =
          flushAtBlock !== undefined && currentBlock !== undefined
            ? Math.max(0, Number(flushAtBlock) - Number(currentBlock))
            : undefined;
        const secsLeft = blocksLeft !== undefined && blocksLeft > 0 ? blocksLeft * 2 : 0;
        const canFlushNow = blocksLeft !== undefined && blocksLeft === 0;

        return (
          <div className="border border-amber-900/60 rounded-lg p-4 bg-amber-900/10">
            <div className="flex items-start gap-3">
              <span className="text-amber-400 text-lg leading-none">⏳</span>
              <div className="space-y-1">
                <p className="text-sm text-amber-400 font-medium">Deposit queued — not yet in Merkle tree</p>
                {canFlushNow ? (
                  <p className="text-xs text-zinc-400">
                    Ready. Click <span className="text-white font-medium">Withdraw</span> — the deposit
                    will be inserted automatically before your proof is generated.
                  </p>
                ) : (
                  <p className="text-xs text-zinc-400">
                    Available in{" "}
                    <span className="text-white font-medium">
                      ~{blocksLeft ?? 50} blocks
                    </span>
                    {secsLeft > 0 && <span className="text-zinc-500"> (~{secsLeft}s)</span>}
                    . Deposits are batched for privacy before entering the tree.
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {noteFlushStatus === "checking" && (
        <p className="text-xs text-zinc-500 text-center">Checking deposit status...</p>
      )}

      <button
        onClick={handleWithdraw}
        disabled={isLoading || (!noteJson && !selectedNullifierHash) || noteFlushStatus === "checking" || (noteFlushStatus === "pending" && (() => {
          const flushAt = lastEpochBlock !== undefined && epochBlocks !== undefined ? lastEpochBlock + epochBlocks : undefined;
          return flushAt !== undefined && currentBlock !== undefined && Number(currentBlock) < Number(flushAt);
        })())}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed
                   text-white font-medium py-3 rounded-lg transition-colors text-sm"
      >
        {noteFlushStatus === "checking"
          ? "Checking note status..."
          : statusMessages[status]}
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
