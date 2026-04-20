"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract, useBlockNumber } from "wagmi";
import { type Address, type Log, formatEther, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { useWithdraw, useGetOwed, useEpochStatus } from "@/lib/contracts";
import {
  deserializeNote,
  generateWithdrawProof,
  type MerklePath,
} from "@/lib/circuits";
import { SHIELDED_POOL_ADDRESS, SHIELDED_POOL_ABI, ALL_SHARD_ADDRESSES, fieldToBytes32 } from "@/lib/contracts";
import { loadNotes, markNoteSpent, storedNoteToNote, noteLabel, type StoredNote } from "@/lib/noteStorage";
import { useNoteKey } from "@/lib/noteKeyContext";
import { useStealthKey } from "@/lib/stealthKeyContext";

// V2: LEVELS=24 — matches ShieldedPool and withdraw_ring.circom
const LEVELS = 24;

// Deployment block of the V2A final contracts (2026-04-09, Base Sepolia block ~40,000,000)
const DEPLOY_BLOCK = 40034191n; // V2B deploy block (2026-04-10)
const CHUNK_SIZE = 9000n;

// keccak256("LeafInserted(bytes32,uint32)") — used to filter only flushEpoch events,
// not Deposit events (both have commitment as topics[1] so we must check topics[0])
const LEAF_INSERTED_TOPIC = "0xa4e4458df45cfeb7eebc696f262212e6721fac69466bfc59f43b6040425afce6";

async function getAllLogs(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  address: `0x${string}`,
  upToBlock?: bigint  // if provided, use exactly this block (it's already confirmed)
): Promise<Log[]> {
  // When no explicit block is given, subtract 1 block as a safety margin:
  // eth_blockNumber can return a value slightly ahead of what the node has
  // indexed for eth_getLogs ("block range extends beyond current head block").
  // Do NOT subtract when upToBlock is explicit — that block is already confirmed
  // (e.g. flushReceipt.blockNumber) and we need events up to exactly that block.
  let latest: bigint;
  if (upToBlock !== undefined) {
    latest = upToBlock;
  } else {
    const rawLatest = await publicClient.getBlockNumber();
    latest = rawLatest > 1n ? rawLatest - 1n : rawLatest;
  }
  const allLogs: Log[] = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK_SIZE) {
    const to = from + CHUNK_SIZE - 1n < latest ? from + CHUNK_SIZE - 1n : latest;
    const chunk = await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
    allLogs.push(...chunk);
  }
  return allLogs;
}

// Scan all 5 shards in parallel — needed because deposits are randomly routed.
// Returns per-shard {shard, logs} so the caller can identify which shard holds a commitment.
async function getAllLogsAllShards(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  upToBlock?: bigint
): Promise<{ shard: Address; logs: Log[] }[]> {
  return Promise.all(
    ALL_SHARD_ADDRESSES.map(async (shard) => ({
      shard,
      logs: await getAllLogs(publicClient, shard, upToBlock),
    }))
  );
}

// Find which shard holds a Deposit event for `commitment`. Returns that shard's address + logs,
// or null if the commitment isn't found on any shard.
function findShardForCommitment(
  shardResults: { shard: Address; logs: Log[] }[],
  commitment: string
): { shard: Address; logs: Log[] } | null {
  for (const r of shardResults) {
    if (r.logs.some((l) => l.topics[1]?.toLowerCase() === commitment.toLowerCase())) {
      return r;
    }
  }
  return null;
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

type WithdrawStatus = "idle" | "flushing" | "fetching-path" | "proving" | "zkverify" | "submitting" | "forwarding" | "done" | "error";

export function WithdrawForm({ onStatusChange }: { onStatusChange?: (s: WithdrawStatus) => void }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { noteKey, isUnlocked, isUnlocking, unlock } = useNoteKey();
  const { stealthMetaAddressURI, spendingPrivateKey, viewingPrivateKey, isLoaded: stealthKeysLoaded, loadKeys } = useStealthKey();

  const { lastEpochBlock, epochBlocks } = useEpochStatus();
  const { data: currentBlock } = useBlockNumber({ watch: true });

  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [selectedNullifierHash, setSelectedNullifierHash] = useState<string>("");
  const [noteJson, setNoteJson] = useState("");
  const [recipient, setRecipient] = useState("");
  const [forwardedTo, setForwardedTo] = useState<string | null>(null);
  // Set when auto-forward fails: the stealth key is needed for manual ETH recovery.
  // Shown in a warning panel so the user can import it to MetaMask and access the funds.
  const [forwardFailKey, setForwardFailKey] = useState<string | null>(null);
  const [status, setStatus] = useState<WithdrawStatus>("idle");

  // Notify parent whenever status changes so it can show a cross-tab progress indicator.
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  // Per-note flush status, keyed by nullifierHash.
  // Built once when savedNotes loads (not per-selection), so switching notes is instant.
  const [flushStatusMap, setFlushStatusMap] = useState<Map<string, "pending" | "ready">>(new Map());
  // Per-note deposit block, keyed by nullifierHash. Used to enforce a personal
  // 50-block minimum privacy window from deposit time, independent of the global epoch timer.
  const [depositBlockMap, setDepositBlockMap] = useState<Map<string, bigint>>(new Map());
  const [checkingFlushStatus, setCheckingFlushStatus] = useState(false);
  // After flushEpoch() confirms, immediately override the stale lastEpochBlock from
  // useEpochStatus (which polls every 12s). Without this, the countdown shows "Ready"
  // for up to 12 seconds after a flush because the hook still returns the old value.
  const [localFlushBlock, setLocalFlushBlock] = useState<bigint | undefined>();
  // effectiveLastEpochBlock: use the larger of the hook value and our local override.
  const effectiveLastEpochBlock =
    localFlushBlock !== undefined && (lastEpochBlock === undefined || localFlushBlock > lastEpochBlock)
      ? localFlushBlock
      : lastEpochBlock;

  const { withdraw, isPending, isConfirming, isSuccess } = useWithdraw();
  const { writeContractAsync } = useWriteContract();

  const reloadNotes = useCallback(() => {
    if (!address) return;
    loadNotes(address, noteKey).then((notes) =>
      setSavedNotes(notes.filter((n) => !n.spent))
    );
  }, [address, noteKey]);

  useEffect(() => { reloadNotes(); }, [reloadNotes]);

  // Reload notes when DepositForm signals a new deposit was saved
  useEffect(() => {
    window.addEventListener("shieldlend:noteAdded", reloadNotes);
    return () => window.removeEventListener("shieldlend:noteAdded", reloadNotes);
  }, [reloadNotes]);

  // ── Batch flush-status check (runs once per notes-load, not per selection) ──
  // Fetches all logs once, then marks every saved note as "pending" or "ready"
  // and records each note's deposit block for the personal privacy countdown.
  useEffect(() => {
    if (!publicClient || savedNotes.length === 0) {
      setFlushStatusMap(new Map());
      setDepositBlockMap(new Map());
      return;
    }
    let cancelled = false;
    setCheckingFlushStatus(true);

    publicClient.getBlockNumber()
      .then((snapshotBlock) => getAllLogsAllShards(publicClient, snapshotBlock))
      .then((shardResults) => {
        // Merge logs from all shards — commitment/LeafInserted matching works across shards
        const logs = shardResults.flatMap((r) => r.logs);
        return logs;
      })
      .then((logs) => {
        if (cancelled) return;
        const newFlushMap = new Map<string, "pending" | "ready">();
        const newDepositMap = new Map<string, bigint>();
        for (const note of savedNotes) {
          // note.commitment is already "0x000...abc" (66 chars) from fieldToBytes32 — use directly.
          const commitment = note.commitment as `0x${string}`;
          // Find the Deposit event to record what block this note was deposited in.
          // This is used to enforce a personal 50-block wait from deposit time,
          // even when the global epoch timer is already overdue.
          const depositLog = logs.find(
            (l) => l.topics[1]?.toLowerCase() === commitment.toLowerCase()
          );
          if (depositLog?.blockNumber != null) {
            newDepositMap.set(note.nullifierHash, depositLog.blockNumber);
          }
          const flushed = logs.some(
            (l) =>
              l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
              l.topics[1]?.toLowerCase() === commitment.toLowerCase()
          );
          newFlushMap.set(note.nullifierHash, flushed ? "ready" : "pending");
        }
        setFlushStatusMap(newFlushMap);
        setDepositBlockMap(newDepositMap);
        setCheckingFlushStatus(false);
      })
      .catch(() => { if (!cancelled) setCheckingFlushStatus(false); });

    return () => { cancelled = true; };
  }, [savedNotes, publicClient]);

  // Derived status for the currently selected note (instant map lookup)
  const noteFlushStatus: "unknown" | "checking" | "pending" | "ready" =
    checkingFlushStatus      ? "checking"
    : !selectedNullifierHash ? "unknown"
    : (flushStatusMap.get(selectedNullifierHash) ?? "unknown");

  // ── Auto-settle preview ────────────────────────────────────────────────────
  // If the selected note has an active loan, show how much the user will receive
  // after the auto-repayment in ShieldedPool.withdraw().
  const nullifierHashHex = selectedNullifierHash
    ? (selectedNullifierHash as `0x${string}`)
    : undefined;

  const { data: owedWei, isFetching: owedFetching } = useGetOwed(nullifierHashHex);

  const selectedNote = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);
  const noteAmountWei = selectedNote ? BigInt(selectedNote.amount) : 0n;
  // Only show loan data when the fetch has fully settled for the current note.
  // gcTime:0 on useGetOwed ensures there is never stale cached data from a previous note.
  const showLoan = !owedFetching && !!owedWei && owedWei > 0n;
  const netReceived =
    showLoan && noteAmountWei > 0n
      ? noteAmountWei > owedWei!
        ? noteAmountWei - owedWei!
        : 0n
      : null;

  async function fetchMerklePath(leafIndex: number, root: `0x${string}`, shardAddress: Address, upToBlock?: bigint): Promise<MerklePath> {
    if (!publicClient) throw new Error("No public client");

    // Only scan the specific shard — each shard has its own independent Merkle tree.
    const logs = await getAllLogs(publicClient, shardAddress, upToBlock);

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

    console.log("[fetchMerklePath] commitMap size:", commitMap.size, "leafIndex:", leafIndex);
    console.log("[fetchMerklePath] contract root:", root);

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

    const computedRoot = currentLevel.get(0) ?? zeros[LEVELS];
    const computedRootHex = "0x" + computedRoot.toString(16).padStart(64, "0");
    console.log("[fetchMerklePath] computed root:", computedRootHex);
    console.log("[fetchMerklePath] roots match:", computedRootHex.toLowerCase() === root.toLowerCase());
    console.log("[fetchMerklePath] pathIndices:", pathIndices.join(","));

    return { pathElements, pathIndices, root: BigInt(root) };
  }

  async function handleWithdraw() {
    if (!selectedNullifierHash && !noteJson.trim()) return setErrorMsg("Select a note or paste JSON");

    try {
      setErrorMsg("");
      setForwardedTo(null);
      setForwardFailKey(null);

      // Derive stealth keys — MetaMask signature once per session, then cached
      let keys: { uri: string; spendKey: string; viewKey: string } | null = null;
      if (stealthKeysLoaded && stealthMetaAddressURI && spendingPrivateKey && viewingPrivateKey) {
        keys = { uri: stealthMetaAddressURI, spendKey: spendingPrivateKey, viewKey: viewingPrivateKey };
      } else {
        keys = await loadKeys();
      }
      if (!keys) throw new Error("Stealth key derivation cancelled");

      const { generateStealthAddress, computeStealthKey, VALID_SCHEME_ID } = await import("@scopelift/stealth-address-sdk");
      const { stealthAddress, ephemeralPublicKey } = generateStealthAddress({ stealthMetaAddressURI: keys.uri });

      setStatus("fetching-path");

      const selectedStored = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);
      const note = selectedStored ? storedNoteToNote(selectedStored) : deserializeNote(noteJson);
      if (!publicClient) throw new Error("No public client");

      const noteCommitment = fieldToBytes32(note.commitment);

      // Scan all 5 shards — deposits are randomly routed so we don't know which shard to look at.
      const shardResults = await getAllLogsAllShards(publicClient);
      const shardMatch = findShardForCommitment(shardResults, noteCommitment);
      if (!shardMatch) throw new Error("Deposit not found on-chain. Wrong network or address?");

      // depositShard: where the commitment lives — used for Merkle path + epoch state.
      // withdrawalShard: the shard that will execute withdraw() and pay ETH to recipient.
      //   V2B cross-shard: choose a DIFFERENT random shard so on-chain observers see
      //   "shard Y → stealth address" and cannot reverse-link to "relay → shard X → user".
      const depositShard = shardMatch.shard;
      const logs = shardMatch.logs;

      // Pick a random withdrawal shard with sufficient ETH, preferring != depositShard.
      const denomination = note.amount;
      const candidateShards = ALL_SHARD_ADDRESSES.filter((s) => s.toLowerCase() !== depositShard.toLowerCase());
      let withdrawalShard: Address = depositShard; // fallback if no others have liquidity
      for (let attempt = 0; attempt < candidateShards.length; attempt++) {
        const idx = Math.floor(Math.random() * candidateShards.length);
        const candidate = candidateShards[idx];
        const bal = await publicClient.getBalance({ address: candidate });
        if (bal >= denomination) {
          withdrawalShard = candidate;
          break;
        }
      }
      // If no other shard has enough ETH, fall back to the deposit shard itself
      if (withdrawalShard === depositShard) {
        const depBal = await publicClient.getBalance({ address: depositShard });
        if (depBal < denomination) throw new Error("No shard has sufficient ETH to pay withdrawal.");
      }
      console.log(`[withdraw] depositShard=${depositShard.slice(0,10)} withdrawalShard=${withdrawalShard.slice(0,10)}`);

      // Look specifically for LeafInserted (topics[0] = LEAF_INSERTED_TOPIC).
      // Deposit events also have topics[1] = commitment but store queue position, not tree index.
      const leafLog = logs.find((l) =>
        l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
        l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
      );

      let resolvedLeafLog = leafLog;
      // logUpToBlock is used to ensure fetchMerklePath queries the same block
      // range that produced resolvedLeafLog — important after an auto-flush.
      let logUpToBlock: bigint | undefined = undefined;

      if (!resolvedLeafLog) {
        // Deposit is queued. Check whether the epoch is ready to flush.
        const lastEpochBlockOnChain = await publicClient.readContract({
          address: depositShard,
          abi: SHIELDED_POOL_ABI,
          functionName: "lastEpochBlock",
        }) as bigint;
        const epochBlocksOnChain = await publicClient.readContract({
          address: depositShard,
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

        // Epoch is ready. Auto-flush on the deposit shard (that's where the commitment is queued).
        setStatus("flushing");
        const flushTxHash = await writeContractAsync({
          address: depositShard,   // flush the DEPOSIT shard's epoch — not the withdrawal shard
          abi: SHIELDED_POOL_ABI,
          functionName: "flushEpoch",
        });

        // Wait for the flush receipt so we know the exact block it landed in.
        // getAllLogs must query UP TO that block — otherwise it may miss the
        // LeafInserted event if the node hasn't indexed the new block yet.
        const flushReceipt = await publicClient.waitForTransactionReceipt({ hash: flushTxHash });
        logUpToBlock = flushReceipt.blockNumber;

        // Immediately update effectiveLastEpochBlock so the countdown in the
        // pending banner reflects the real post-flush value without waiting for
        // the 12-second useEpochStatus poll to fire.
        setLocalFlushBlock(flushReceipt.blockNumber);

        // flushEpoch() flushes ALL queued deposits, not just the selected one.
        // Mark every pending note as "ready" so their banners don't reset
        // to a 50-block countdown after lastEpochBlock updates on-chain.
        setFlushStatusMap((prev) => {
          const next = new Map(prev);
          for (const [key, val] of prev) {
            if (val === "pending") next.set(key, "ready");
          }
          return next;
        });

        setStatus("fetching-path");
        const freshLogs = await getAllLogs(publicClient, depositShard, logUpToBlock);
        resolvedLeafLog = freshLogs.find((l) =>
          l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
          l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
        );

        if (!resolvedLeafLog) throw new Error("Flush succeeded but LeafInserted event not found. Try withdrawing again.");
      }

      const leafIndex = parseInt(resolvedLeafLog.data.slice(2, 66), 16);

      // Read root from the DEPOSIT shard — proof is generated against its tree.
      // The withdrawal shard accepts this root via LendingPool.isValidRoot() (V2B cross-shard).
      const freshRoot = (await publicClient.readContract({
        address: depositShard,
        abi: SHIELDED_POOL_ABI,
        functionName: "getLastRoot",
      })) as `0x${string}`;

      // Merkle path is built from the deposit shard's LeafInserted events (its own tree).
      const merklePath = await fetchMerklePath(leafIndex, freshRoot, depositShard, logUpToBlock);

      setStatus("proving");
      // V2: circuit name is "withdraw_ring" — server maps to withdraw_ring_vkey.json
      const { proof, publicSignals } = await generateWithdrawProof(note, merklePath, stealthAddress);

      setStatus("zkverify");
      const zkRes = await fetch("/api/zkverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          circuit: "withdraw_ring",
          proof,
          publicSignals,
          recipient: stealthAddress,
          amount: note.amount.toString(),
        }),
      });
      if (!zkRes.ok) throw new Error(`zkVerify failed: ${await zkRes.text()}`);
      const zkResult: ZkVerifyResult = await zkRes.json();

      setStatus("submitting");
      const nullifierHashHex = fieldToBytes32(note.nullifierHash);

      // Call withdraw() on the WITHDRAWAL shard (V2B cross-shard: may differ from depositShard).
      // The withdrawal shard accepts the root via LendingPool.isValidRoot() and pays ETH to stealth.
      await withdraw(
        freshRoot,
        nullifierHashHex,
        stealthAddress as Address,
        note.amount,
        BigInt(zkResult.domainId ?? 0),
        BigInt(zkResult.aggregationId),
        (zkResult.merklePath ?? []) as `0x${string}`[],
        BigInt(zkResult.leafCount ?? 1),
        BigInt(zkResult.leafIndex ?? 0),
        withdrawalShard  // pays from a different shard than where the deposit landed
      );

      setTxHash(zkResult.txHash);

      // Mark note spent immediately after the on-chain withdrawal confirms.
      // Must happen BEFORE the auto-forward attempt — if the forward fails,
      // the nullifier is already spent on-chain and the note must not appear
      // as withdrawable in the UI (retrying would always revert on-chain).
      if (address) {
        const nhex = selectedNullifierHash || fieldToBytes32(note.nullifierHash);
        await markNoteSpent(address, nhex, noteKey);
        setSavedNotes((prev) => prev.filter((n) => n.nullifierHash !== selectedNullifierHash));
      }

      // Compute stealth private key — used once to forward funds.
      // Stored in forwardFailKey only if the forward fails (for manual recovery).
      const stealthPrivKey = computeStealthKey({
        ephemeralPublicKey,
        spendingPrivateKey: keys.spendKey as `0x${string}`,
        viewingPrivateKey: keys.viewKey as `0x${string}`,
        schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
      });

      const effectiveRecipient = (recipient.trim() || address) as Address;
      setStatus("forwarding");
      setForwardFailKey(null);

      // Auto-forward wrapped in its own try/catch — the withdrawal already succeeded.
      // If the forward fails, we show the stealth private key so the user can
      // import it to MetaMask and manually access the funds.
      try {
        const stealthAccount = privateKeyToAccount(stealthPrivKey as `0x${string}`);
        const stealthClient = createWalletClient({
          account: stealthAccount,
          chain: baseSepolia,
          transport: http("https://sepolia.base.org"),
        });

        // Poll until stealth address has balance (withdrawal must fully confirm first)
        let balance = 0n;
        for (let attempt = 0; attempt < 10; attempt++) {
          balance = await publicClient.getBalance({ address: stealthAddress as Address });
          if (balance > 0n) break;
          await new Promise((r) => setTimeout(r, 3000));
        }

        if (balance > 0n) {
          const gasPrice = await publicClient.getGasPrice();
          const bufferedGasPrice = gasPrice + gasPrice / 5n;
          // Base is an L2: every tx pays an L1 data fee on top of L2 gas.
          // getGasPrice() returns only the L2 fee. The L1 data fee (~910M wei
          // on testnet) must be reserved separately — without this reserve the
          // tx fails with "insufficient funds" even when the L2 gas is covered.
          const L1_DATA_FEE_RESERVE = 10_000_000_000n; // 10B wei, ~10x observed L1 fee
          const gasCost = bufferedGasPrice * 21000n + L1_DATA_FEE_RESERVE;
          const sendAmount = balance > gasCost ? balance - gasCost : 0n;
          if (sendAmount > 0n) {
            await stealthClient.sendTransaction({
              to:       effectiveRecipient,
              value:    sendAmount,
              gas:      21000n,
              gasPrice: bufferedGasPrice,
            });
          }
        }
        setForwardedTo(effectiveRecipient);
      } catch {
        // Forward failed — withdrawal already succeeded and note is marked spent.
        // Show the stealth private key so the user can recover funds from MetaMask.
        setForwardFailKey(stealthPrivKey as string);
      }

      // Withdrawal succeeded regardless of auto-forward result.
      setStatus("done");
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
    forwarding: "Forwarding to recipient...",
    done: "Withdrawn",
    error: "Withdraw",
  };

  const isLoading =
    ["flushing", "fetching-path", "proving", "zkverify", "submitting", "forwarding"].includes(status) ||
    isPending ||
    isConfirming;

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm text-zinc-400 mb-2">Note (from deposit)</label>
        {!isUnlocked && (
          <div className="flex items-center gap-3 mb-3 p-3 rounded-lg border border-zinc-700 bg-zinc-900/50">
            <span className="text-xs text-zinc-400 flex-1">Vault locked — sign to load saved notes</span>
            <button
              onClick={unlock}
              disabled={isUnlocking}
              className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {isUnlocking ? "Signing…" : "Unlock vault"}
            </button>
          </div>
        )}
        {savedNotes.length > 0 && (
          <select
            value={selectedNullifierHash}
            onChange={(e) => {
              setSelectedNullifierHash(e.target.value);
              setNoteJson("");
              setStatus("idle");
              setErrorMsg("");
            }}
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
      {showLoan && (
        <div className="border border-amber-900/60 rounded-lg p-4 bg-amber-900/10 text-xs space-y-2">
          <p className="text-amber-400 font-medium">Collateral note — loan will be auto-settled</p>
          <div className="flex justify-between text-zinc-400">
            <span>Loan repayment (deducted)</span>
            <span className="font-mono text-red-400">- {parseFloat(formatEther(owedWei!)).toFixed(6)} ETH</span>
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

      {/* Recipient — final destination for funds after stealth forwarding */}
      <div>
        <label className="block text-sm text-zinc-400 mb-2">Send funds to</label>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x... (leave blank to forward to your connected wallet)"
          disabled={isLoading}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono
                     focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
        />
        <p className="text-xs text-zinc-600 mt-1">
          Funds route through a one-time stealth address — your deposit wallet is never linked to the destination.
          Defaults to your connected wallet if left blank.
        </p>
      </div>

      {/* Pending epoch banner.
          Two states:
          1. blocksLeft > 0 — epoch not ready yet, amber countdown, button disabled.
          2. blocksLeft = 0 — epoch overdue, note can be flushed immediately.
             Show a distinct indigo "ready" banner so the user knows the note is
             still pending (not yet in the tree) but they can click Withdraw now. */}
      {noteFlushStatus === "pending" && (() => {
        const globalFlushAt =
          effectiveLastEpochBlock !== undefined && epochBlocks !== undefined
            ? effectiveLastEpochBlock + epochBlocks
            : undefined;
        // Personal privacy window: note must wait EPOCH_BLOCKS from its own deposit block,
        // even if the global epoch timer is already overdue. Prevents zero-block privacy windows.
        // Fallback: if the on-chain Deposit event wasn't indexed yet (fresh deposit in the latest
        // block is missed by the -1 safety margin in getAllLogs), estimate deposit block from the
        // saved depositedAt timestamp (2s/block on Base Sepolia).
        const depositBlockFromLogs = selectedNullifierHash ? depositBlockMap.get(selectedNullifierHash) : undefined;
        const depositBlockFromTimestamp =
          selectedNote?.depositedAt && currentBlock
            ? currentBlock - BigInt(Math.floor((Date.now() - selectedNote.depositedAt) / 2000))
            : undefined;
        const depositBlock = depositBlockFromLogs ??
          (depositBlockFromTimestamp !== undefined && depositBlockFromTimestamp > 0n
            ? depositBlockFromTimestamp
            : undefined);
        const personalFlushAt =
          depositBlock !== undefined && epochBlocks !== undefined
            ? depositBlock + epochBlocks
            : undefined;
        // Use the later of the two: global epoch timer vs personal deposit window.
        const flushAtBlock =
          globalFlushAt !== undefined && personalFlushAt !== undefined
            ? globalFlushAt > personalFlushAt ? globalFlushAt : personalFlushAt
            : (globalFlushAt ?? personalFlushAt);
        const blocksLeft =
          flushAtBlock !== undefined && currentBlock !== undefined
            ? Math.max(0, Number(flushAtBlock) - Number(currentBlock))
            : undefined;
        const secsLeft = blocksLeft !== undefined && blocksLeft > 0 ? blocksLeft * 2 : 0;
        const canFlushNow = blocksLeft !== undefined && blocksLeft === 0;

        if (canFlushNow) {
          // Epoch is overdue — withdraw is immediately possible via auto-flush.
          // Show indigo info banner (not amber warning) so the user knows they
          // can proceed, but still sees that the note isn't in the tree yet.
          return (
            <div className="border border-indigo-800/60 rounded-lg p-4 bg-indigo-950/30">
              <div className="flex items-start gap-3">
                <span className="text-indigo-400 text-base leading-none">↓</span>
                <div className="space-y-1">
                  <p className="text-sm text-indigo-300 font-medium">Deposit queued — ready to insert</p>
                  <p className="text-xs text-zinc-400">
                    Click <span className="text-white font-medium">Withdraw</span> — the epoch will flush
                    automatically, inserting your deposit into the Merkle tree before your proof is generated.
                  </p>
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="border border-amber-900/60 rounded-lg p-4 bg-amber-900/10">
            <div className="flex items-start gap-3">
              <span className="text-amber-400 text-lg leading-none">⏳</span>
              <div className="space-y-1">
                <p className="text-sm text-amber-400 font-medium">Deposit queued — not yet in Merkle tree</p>
                <p className="text-xs text-zinc-400">
                  Available in{" "}
                  <span className="text-white font-medium">
                    ~{blocksLeft ?? 50} blocks
                  </span>
                  {secsLeft > 0 && <span className="text-zinc-500"> (~{secsLeft}s)</span>}
                  . Deposits are batched for privacy before entering the tree.
                </p>
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
          const globalFlushAt = effectiveLastEpochBlock !== undefined && epochBlocks !== undefined ? effectiveLastEpochBlock + epochBlocks : undefined;
          const depositBlock = selectedNullifierHash ? depositBlockMap.get(selectedNullifierHash) : undefined;
          const personalFlushAt = depositBlock !== undefined && epochBlocks !== undefined ? depositBlock + epochBlocks : undefined;
          const flushAt = globalFlushAt !== undefined && personalFlushAt !== undefined
            ? (globalFlushAt > personalFlushAt ? globalFlushAt : personalFlushAt)
            : (globalFlushAt ?? personalFlushAt);
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

      {status === "done" && forwardedTo && (
        <div className="border border-green-800 rounded-lg p-4 bg-green-950/20 space-y-2 text-xs">
          <p className="text-sm text-green-400 font-medium">Withdrawal complete — funds forwarded privately</p>
          <p className="text-zinc-400">
            Routed through a one-time stealth address and forwarded to{" "}
            <span className="font-mono text-zinc-300">{forwardedTo.slice(0, 10)}...{forwardedTo.slice(-6)}</span>
          </p>
          <p className="text-zinc-600">Stealth key destroyed after use — not linkable to your deposit address.</p>
        </div>
      )}

      {status === "done" && forwardFailKey && (
        <div className="border border-amber-700 rounded-lg p-4 bg-amber-950/20 space-y-3 text-xs">
          <p className="text-sm text-amber-400 font-medium">Withdrawal succeeded — manual recovery needed</p>
          <p className="text-zinc-400">
            Your ETH was withdrawn from the pool but the auto-forward to your wallet failed.
            Your funds are sitting on a one-time stealth address. Import the key below into MetaMask to access them.
          </p>
          <div className="space-y-1">
            <p className="text-zinc-500">Stealth private key (import to MetaMask):</p>
            <div className="flex items-start gap-2">
              <span className="font-mono text-amber-300 text-xs break-all leading-relaxed">{forwardFailKey}</span>
              <button
                onClick={() => navigator.clipboard.writeText(forwardFailKey)}
                className="shrink-0 text-indigo-400 hover:text-indigo-300 underline whitespace-nowrap"
              >
                Copy
              </button>
            </div>
          </div>
          <p className="text-red-400 font-medium">Delete this key from your clipboard after importing it.</p>
        </div>
      )}
    </div>
  );
}
