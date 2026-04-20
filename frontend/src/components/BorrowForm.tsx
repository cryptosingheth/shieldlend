"use client";

import { useState, useEffect } from "react";
import { parseEther, formatEther, type Log, type Address, createWalletClient, http } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { deserializeNote, generateCollateralProof, type MerklePath } from "@/lib/circuits";
import { useHasActiveLoan, fieldToBytes32, LENDING_POOL_ADDRESS, LENDING_POOL_ABI, SHIELDED_POOL_ABI, ALL_SHARD_ADDRESSES } from "@/lib/contracts";
import { loadNotes, storedNoteToNote, noteLabel, type StoredNote } from "@/lib/noteStorage";
import { useNoteKey } from "@/lib/noteKeyContext";
import { useStealthKey } from "@/lib/stealthKeyContext";

// V2: MIN_HEALTH_FACTOR_BPS = 11000 (110%) in LendingPool.sol
const MIN_HEALTH_FACTOR_BPS = 11000n;
const BPS_DENOMINATOR = 10000n;

// Merkle tree constants — must match ShieldedPool and collateral_ring.circom
const LEVELS = 24;
// Deployment block of the V2A final contracts (2026-04-09, Base Sepolia block ~40,000,000)
const DEPLOY_BLOCK = 40034191n; // V2B deploy block (2026-04-10)
const CHUNK_SIZE = 9000n;
// keccak256("LeafInserted(bytes32,uint32)") — filter for post-flush tree insertions only
const LEAF_INSERTED_TOPIC = "0xa4e4458df45cfeb7eebc696f262212e6721fac69466bfc59f43b6040425afce6";

function healthColor(hf: number): string {
  if (hf >= 2.0) return "text-green-400";
  if (hf >= 1.5) return "text-amber-400";
  return "text-red-400";
}

function healthLabel(hf: number): string {
  if (hf >= 2.0) return "Healthy";
  if (hf >= 1.5) return "Moderate";
  return "At risk";
}

async function getAllLogs(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  address: `0x${string}`,
  upToBlock?: bigint
): Promise<Log[]> {
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

// Scan all 5 shards in parallel — deposits are randomly routed so we must check all.
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

// Find which shard holds a Deposit (or LeafInserted) event for `commitment`.
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

export function BorrowForm() {
  const { address } = useAccount();
  const { noteKey, isUnlocked, isUnlocking, unlock } = useNoteKey();
  const { stealthMetaAddressURI, spendingPrivateKey, viewingPrivateKey, isLoaded: stealthKeysLoaded, loadKeys } = useStealthKey();
  const publicClient = usePublicClient();

  // ── Note selection ────────────────────────────────────────────────────────
  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [selectedNullifierHash, setSelectedNullifierHash] = useState<string>("");
  const [noteJson, setNoteJson] = useState("");

  useEffect(() => {
    if (!address) return;
    loadNotes(address, noteKey).then((notes) =>
      setSavedNotes(notes.filter((n) => !n.spent))
    );
  }, [address, noteKey]);

  const selectedNote = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);

  // ── Borrow state ──────────────────────────────────────────────────────────
  const [borrowEth, setBorrowEth] = useState("");
  const [borrowStatus, setBorrowStatus] = useState<
    "idle" | "flushing" | "fetching-path" | "proving" | "zkverify" | "submitting" | "forwarding" | "done" | "error"
  >("idle");
  const [borrowError, setBorrowError] = useState("");
  const [borrowTxHash, setBorrowTxHash] = useState<string | null>(null);
  const [forwardedTo, setForwardedTo] = useState<string | null>(null);
  const [forwardFailKey, setForwardFailKey] = useState<string | null>(null);

  // ── Repay state ───────────────────────────────────────────────────────────
  const [repayStatus, setRepayStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [repayError, setRepayError] = useState("");

  // Active loans discovered from the user's vault notes.
  // Each entry: loanId + details fetched from getLoanDetails().
  interface UserLoan {
    loanId: bigint;
    noteLabel: string;              // human-readable note identifier
    borrowed: bigint;
    currentInterest: bigint;
    totalOwed: bigint;
    repaid: boolean;
  }
  const [userLoans, setUserLoans] = useState<UserLoan[]>([]);
  const [loadingLoans, setLoadingLoans] = useState(false);
  const [selectedLoanId, setSelectedLoanId] = useState<string>("");

  // ── Load active loans from vault notes ────────────────────────────────────
  // For each saved note, check hasActiveLoan → activeLoanByNote → getLoanDetails.
  // Done with publicClient.readContract in parallel (can't call hooks in a loop).
  useEffect(() => {
    if (!publicClient || savedNotes.length === 0) { setUserLoans([]); return; }
    let cancelled = false;
    setLoadingLoans(true);

    async function fetchLoans() {
      const results: UserLoan[] = [];
      await Promise.all(
        savedNotes.map(async (note) => {
          const nhex = note.nullifierHash as `0x${string}`;
          const hasActive = await publicClient!.readContract({
            address: LENDING_POOL_ADDRESS,
            abi: LENDING_POOL_ABI,
            functionName: "hasActiveLoan",
            args: [nhex],
          }) as boolean;
          if (!hasActive) return;

          const loanId = await publicClient!.readContract({
            address: LENDING_POOL_ADDRESS,
            abi: LENDING_POOL_ABI,
            functionName: "activeLoanByNote",
            args: [nhex],
          }) as bigint;

          const details = await publicClient!.readContract({
            address: LENDING_POOL_ADDRESS,
            abi: LENDING_POOL_ABI,
            functionName: "getLoanDetails",
            args: [loanId],
          }) as [string, bigint, bigint, bigint, boolean];

          results.push({
            loanId,
            noteLabel: noteLabel(note),
            borrowed: details[1],
            currentInterest: details[2],
            totalOwed: details[3],
            repaid: details[4],
          });
        })
      );
      if (!cancelled) {
        // Sort by loanId ascending so newest loan is last
        results.sort((a, b) => (a.loanId < b.loanId ? -1 : 1));
        setUserLoans(results);
        setLoadingLoans(false);
      }
    }

    fetchLoans().catch(() => { if (!cancelled) setLoadingLoans(false); });
    return () => { cancelled = true; };
  }, [savedNotes, publicClient]);

  // ── Contract read hooks ───────────────────────────────────────────────────
  const nullifierHashHex =
    selectedNote?.nullifierHash ??
    (noteJson
      ? (() => { try { return fieldToBytes32(deserializeNote(noteJson).nullifierHash); } catch { return undefined; } })()
      : undefined);

  const { data: hasLoan } = useHasActiveLoan(nullifierHashHex as `0x${string}` | undefined);

  const selectedLoan = userLoans.find((l) => l.loanId.toString() === selectedLoanId);

  const { writeContractAsync } = useWriteContract();

  // ── Derived: health factor preview ───────────────────────────────────────
  const noteForCalc = selectedNote
    ? storedNoteToNote(selectedNote)
    : (() => { try { return deserializeNote(noteJson); } catch { return null; } })();

  const collateral = noteForCalc?.amount ?? 0n;
  const borrowWei = borrowEth
    ? (() => { try { return parseEther(borrowEth); } catch { return 0n; } })()
    : 0n;

  // HF = (collateral / borrowed) expressed relative to MIN_HEALTH_FACTOR_BPS floor
  const healthFactor =
    borrowWei > 0n && collateral > 0n
      ? Number((collateral * BPS_DENOMINATOR) / (MIN_HEALTH_FACTOR_BPS * borrowWei / BPS_DENOMINATOR)) / 10000
      : null;

  const maxBorrowable = collateral > 0n
    ? formatEther((collateral * BPS_DENOMINATOR) / MIN_HEALTH_FACTOR_BPS)
    : null;

  // ── Merkle path fetcher — scans the specific shard the note was deposited on ──
  async function fetchMerklePath(leafIndex: number, root: `0x${string}`, shardAddress: Address, upToBlock?: bigint): Promise<MerklePath> {
    if (!publicClient) throw new Error("No public client");

    const logs = await getAllLogs(publicClient, shardAddress, upToBlock);

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

  // ── Borrow handler ────────────────────────────────────────────────────────
  async function handleBorrow() {
    const note = noteForCalc;
    if (!note) return setBorrowError("Select a note or paste JSON");
    if (!borrowEth || isNaN(Number(borrowEth))) return setBorrowError("Enter borrow amount");
    if (!address) return setBorrowError("Connect wallet first");
    if (!publicClient) return setBorrowError("No public client");

    try {
      setBorrowError("");
      setForwardedTo(null);
      setForwardFailKey(null);
      const borrowAmount = parseEther(borrowEth);

      // Client-side health check: collateral * 10000 >= borrowed * MIN_HEALTH_FACTOR_BPS
      if (note.amount * BPS_DENOMINATOR < borrowAmount * MIN_HEALTH_FACTOR_BPS) {
        const minCollateral = formatEther((MIN_HEALTH_FACTOR_BPS * borrowAmount) / BPS_DENOMINATOR);
        throw new Error(`Insufficient collateral. Need ${minCollateral} ETH, have ${formatEther(note.amount)} ETH`);
      }

      // ── Step 1: Derive stealth keys (same as WithdrawForm) ──────────────────
      // Borrowed ETH is routed through a one-time stealth address so the
      // on-chain recipient is never directly linked to the user's MetaMask wallet.
      let keys: { uri: string; spendKey: string; viewKey: string } | null = null;
      if (stealthKeysLoaded && stealthMetaAddressURI && spendingPrivateKey && viewingPrivateKey) {
        keys = { uri: stealthMetaAddressURI, spendKey: spendingPrivateKey, viewKey: viewingPrivateKey };
      } else {
        keys = await loadKeys();
      }
      if (!keys) throw new Error("Stealth key derivation cancelled");

      const { generateStealthAddress, computeStealthKey, VALID_SCHEME_ID } = await import("@scopelift/stealth-address-sdk");
      const { stealthAddress, ephemeralPublicKey } = generateStealthAddress({ stealthMetaAddressURI: keys.uri });

      // ── Step 2: Scan ALL shards to find which shard holds this note ─────────
      // Deposits are randomly routed — we cannot assume the note is on Shard 1.
      setBorrowStatus("fetching-path");
      const noteCommitment = fieldToBytes32(note.commitment);
      const shardResults = await getAllLogsAllShards(publicClient);
      const shardMatch = findShardForCommitment(shardResults, noteCommitment);
      if (!shardMatch) throw new Error("Deposit not found on-chain. Wrong network or old note?");

      const depositShard = shardMatch.shard;
      const shardLogs = shardMatch.logs;

      let leafLog = shardLogs.find((l) =>
        l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
        l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
      );
      let logUpToBlock: bigint | undefined = undefined;

      if (!leafLog) {
        // Note is queued — check if epoch on the DEPOSIT shard is ready to flush.
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
            `Note not yet in Merkle tree — epoch flushes in ~${blocksLeft} blocks (~${blocksLeft * 2}s). Try again then.`
          );
        }

        // Epoch overdue — auto-flush the deposit shard before generating proof.
        setBorrowStatus("flushing" as typeof borrowStatus);
        const flushTxHash = await writeContractAsync({
          address: depositShard,
          abi: SHIELDED_POOL_ABI,
          functionName: "flushEpoch",
        });
        const flushReceipt = await publicClient.waitForTransactionReceipt({ hash: flushTxHash });
        logUpToBlock = flushReceipt.blockNumber;

        setBorrowStatus("fetching-path");
        const freshLogs = await getAllLogs(publicClient, depositShard, logUpToBlock);
        leafLog = freshLogs.find((l) =>
          l.topics[0]?.toLowerCase() === LEAF_INSERTED_TOPIC &&
          l.topics[1]?.toLowerCase() === noteCommitment.toLowerCase()
        );
        if (!leafLog) throw new Error("Flush succeeded but note not found in tree. Try again.");
      }

      const leafIndex = parseInt(leafLog.data.slice(2, 66), 16);

      // Read root from the deposit shard — proof is generated against its specific tree.
      const freshRoot = (await publicClient.readContract({
        address: depositShard,
        abi: SHIELDED_POOL_ABI,
        functionName: "getLastRoot",
      })) as `0x${string}`;

      // Merkle path is built from the deposit shard's LeafInserted events.
      const merklePath = await fetchMerklePath(leafIndex, freshRoot, depositShard, logUpToBlock);

      setBorrowStatus("proving");
      const { proof, publicSignals } = await generateCollateralProof(
        note,
        merklePath,
        borrowAmount,
        MIN_HEALTH_FACTOR_BPS
      );

      setBorrowStatus("zkverify");
      // /api/borrow handles zkVerify submission AND the on-chain borrow() call via
      // operator key. It picks a random disburseShard ≠ collateralShard (V2B privacy).
      // Borrowed ETH goes to stealthAddress — NOT the user's MetaMask wallet directly.
      const borrowRes = await fetch("/api/borrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof,
          publicSignals,
          noteNullifierHash:  fieldToBytes32(note.nullifierHash),
          borrowed:           borrowAmount.toString(),
          collateralAmount:   note.amount.toString(),
          recipient:          stealthAddress,     // stealth address — not user's wallet
          collateralShard:    depositShard,        // tells server which shard to lock
        }),
      });
      if (!borrowRes.ok) throw new Error(`Borrow failed: ${await borrowRes.text()}`);
      const borrowResult = await borrowRes.json();
      setBorrowTxHash(borrowResult.txHash);

      // ── Step 3: Auto-forward stealthAddress → user's wallet ─────────────────
      setBorrowStatus("forwarding");
      const stealthPrivKey = computeStealthKey({
        ephemeralPublicKey,
        spendingPrivateKey: keys.spendKey as `0x${string}`,
        viewingPrivateKey:  keys.viewKey as `0x${string}`,
        schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
      });

      try {
        const stealthAccount = privateKeyToAccount(stealthPrivKey as `0x${string}`);
        const stealthClient = createWalletClient({
          account:   stealthAccount,
          chain:     baseSepolia,
          transport: http("https://sepolia.base.org"),
        });

        let balance = 0n;
        for (let attempt = 0; attempt < 10; attempt++) {
          balance = await publicClient.getBalance({ address: stealthAddress as Address });
          if (balance > 0n) break;
          await new Promise((r) => setTimeout(r, 3000));
        }

        if (balance > 0n) {
          const gasPrice = await publicClient.getGasPrice();
          const bufferedGasPrice = gasPrice + gasPrice / 5n;
          const L1_DATA_FEE_RESERVE = 10_000_000_000n;
          const gasCost = bufferedGasPrice * 21000n + L1_DATA_FEE_RESERVE;
          const sendAmount = balance > gasCost ? balance - gasCost : 0n;
          if (sendAmount > 0n) {
            await stealthClient.sendTransaction({
              to:       address as Address,
              value:    sendAmount,
              gas:      21000n,
              gasPrice: bufferedGasPrice,
            });
            setForwardedTo(address);
          }
        }
      } catch {
        setForwardFailKey(stealthPrivKey as string);
      }

      setBorrowStatus("done");
    } catch (err) {
      setBorrowStatus("error");
      setBorrowError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  // ── Repay handler ─────────────────────────────────────────────────────────
  async function handleRepay() {
    if (!selectedLoan) return setRepayError("Select a loan first");
    if (selectedLoan.repaid) return setRepayError("This loan has already been repaid");
    if (!publicClient) return setRepayError("No public client");
    try {
      setRepayError("");
      setRepayStatus("submitting");

      // Re-read totalOwed fresh at repay time — the value in state is stale.
      // Interest accrues per-block, so a stale msg.value hits InsufficientRepayment.
      // Add a 0.1% buffer on top; the contract refunds any overpayment automatically.
      const freshDetails = await publicClient.readContract({
        address: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: "getLoanDetails",
        args: [selectedLoan.loanId],
      }) as [string, bigint, bigint, bigint, boolean];
      const freshTotalOwed = freshDetails[3];
      const sendAmount = freshTotalOwed + freshTotalOwed / 1000n; // +0.1% buffer

      await writeContractAsync({
        address: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: "repay",
        args: [selectedLoan.loanId],
        value: sendAmount,
      });
      setRepayStatus("done");
    } catch (err) {
      setRepayStatus("error");
      setRepayError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  const isBorrowing = ["flushing", "fetching-path", "proving", "zkverify", "submitting", "forwarding"].includes(borrowStatus);

  const borrowLabel: Record<typeof borrowStatus, string> = {
    idle: "Borrow",
    flushing: "Inserting into Merkle tree...",
    "fetching-path": "Fetching Merkle path...",
    proving: "Generating collateral ring proof (~25s)...",
    zkverify: "Verifying proof + confirming borrow...",
    submitting: "Confirming borrow...",
    forwarding: "Forwarding to your wallet...",
    done: "Borrowed",
    error: "Borrow",
  };

  return (
    <div className="space-y-8">
      {/* ── Borrow section ────────────────────────────────────────────────── */}
      <div className="space-y-5">
        <div className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 text-xs text-zinc-400 space-y-1">
          <p>Prove collateral &gt; 110% of borrow amount using a ZK ring proof — your note value and identity stay private.</p>
          <p>Note must be in the Merkle tree (epoch flushed) before borrowing.</p>
        </div>

        {/* Note selection */}
        <div>
          <label className="block text-sm text-zinc-400 mb-2">Collateral note</label>
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
          {savedNotes.length > 0 ? (
            <select
              value={selectedNullifierHash}
              onChange={(e) => {
                setSelectedNullifierHash(e.target.value);
                setNoteJson("");
                setBorrowStatus("idle");
                setBorrowError("");
              }}
              disabled={isBorrowing}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm
                         focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
            >
              <option value="">— Select a saved note —</option>
              {savedNotes.map((n) => (
                <option key={n.nullifierHash} value={n.nullifierHash}>
                  {noteLabel(n)}
                </option>
              ))}
            </select>
          ) : null}

          {!selectedNullifierHash && (
            <textarea
              value={noteJson}
              onChange={(e) => setNoteJson(e.target.value)}
              placeholder='{"nullifier":"...","secret":"...","amount":"...","commitment":"...","nullifierHash":"..."}'
              disabled={isBorrowing}
              rows={3}
              className={`w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-xs font-mono
                         focus:outline-none focus:border-indigo-500 disabled:opacity-50 resize-none transition-colors
                         ${savedNotes.length > 0 ? "mt-2" : ""}`}
            />
          )}

          {collateral > 0n && (
            <div className="mt-2 flex items-center gap-4 text-xs text-zinc-500">
              <span>Collateral: <span className="text-zinc-300 font-mono">{formatEther(collateral)} ETH</span></span>
              {maxBorrowable && (
                <span>Max borrow: <span className="text-zinc-300 font-mono">{maxBorrowable} ETH</span></span>
              )}
            </div>
          )}

          {hasLoan && (
            <p className="text-xs text-amber-400 mt-1">
              This note already has an active loan. Repay it first.
            </p>
          )}
        </div>

        {/* Borrow amount */}
        <div>
          <label className="block text-sm text-zinc-400 mb-2">Borrow amount (ETH)</label>
          <input
            type="number"
            step="0.001"
            min="0"
            value={borrowEth}
            onChange={(e) => setBorrowEth(e.target.value)}
            placeholder="0.05"
            disabled={isBorrowing}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono
                       focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
          />

          {healthFactor !== null && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Health factor:</span>
              <span className={`font-semibold font-mono ${healthColor(healthFactor)}`}>
                {healthFactor.toFixed(2)}
              </span>
              <span className={healthColor(healthFactor)}>
                · {healthLabel(healthFactor)}
              </span>
            </div>
          )}
        </div>

        <button
          onClick={handleBorrow}
          disabled={isBorrowing || (!noteJson && !selectedNullifierHash) || !borrowEth || !!hasLoan}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed
                     text-white font-medium py-3 rounded-lg transition-colors text-sm"
        >
          {borrowLabel[borrowStatus]}
          {isBorrowing && (
            <span className="ml-2 inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin align-middle" />
          )}
        </button>

        {borrowError && (
          <p className="text-sm text-red-400 border border-red-900 rounded-lg px-4 py-3">{borrowError}</p>
        )}
        {borrowStatus === "done" && borrowTxHash && (
          <div className="border border-green-800 rounded-lg p-4 bg-green-950/20 space-y-2 text-xs">
            <p className="text-sm text-green-400 font-medium">Loan disbursed — funds forwarded privately</p>
            {forwardedTo && (
              <p className="text-zinc-400">
                Routed through a one-time stealth address and forwarded to{" "}
                <span className="font-mono text-zinc-300">{forwardedTo.slice(0, 10)}...{forwardedTo.slice(-6)}</span>
              </p>
            )}
            <p className="text-zinc-500">tx: {borrowTxHash.slice(0, 10)}...</p>
          </div>
        )}
        {borrowStatus === "done" && forwardFailKey && (
          <div className="border border-amber-700 rounded-lg p-4 bg-amber-950/20 space-y-3 text-xs">
            <p className="text-sm text-amber-400 font-medium">Borrow succeeded — manual recovery needed</p>
            <p className="text-zinc-400">Funds were disbursed but the auto-forward failed. Import this key into MetaMask to access your ETH.</p>
            <div className="space-y-1">
              <p className="text-zinc-500">Stealth private key:</p>
              <div className="flex items-start gap-2">
                <span className="font-mono text-amber-300 text-xs break-all leading-relaxed">{forwardFailKey}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(forwardFailKey)}
                  className="shrink-0 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors"
                >Copy</button>
              </div>
            </div>
            <p className="text-red-400 font-medium">Delete this key from your clipboard after importing.</p>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800" />

      {/* ── Repay section ─────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-300">Repay a loan</h3>

        {loadingLoans ? (
          <p className="text-xs text-zinc-500">Loading your active loans...</p>
        ) : userLoans.length === 0 ? (
          <p className="text-xs text-zinc-500">No active loans found for your vault notes.</p>
        ) : (
          <div>
            <label className="block text-sm text-zinc-400 mb-2">Select loan</label>
            <select
              value={selectedLoanId}
              onChange={(e) => { setSelectedLoanId(e.target.value); setRepayStatus("idle"); setRepayError(""); }}
              disabled={repayStatus === "submitting"}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm
                         focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
            >
              <option value="">— Select a loan —</option>
              {userLoans.map((loan) => (
                <option key={loan.loanId.toString()} value={loan.loanId.toString()}>
                  Loan #{loan.loanId.toString()} · {loan.noteLabel} · {parseFloat(formatEther(loan.borrowed)).toFixed(4)} ETH
                </option>
              ))}
            </select>
          </div>
        )}

        {selectedLoan && (
          <div className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 text-xs space-y-2">
            <div className="flex justify-between">
              <span className="text-zinc-500">Principal</span>
              <span className="font-mono text-zinc-200">{formatEther(selectedLoan.borrowed)} ETH</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Accrued interest</span>
              <span className="font-mono text-zinc-200">{formatEther(selectedLoan.currentInterest)} ETH</span>
            </div>
            <div className="flex justify-between border-t border-zinc-800 pt-2">
              <span className="text-zinc-400 font-medium">Total owed</span>
              <span className="font-mono text-white font-semibold">{formatEther(selectedLoan.totalOwed)} ETH</span>
            </div>
            {selectedLoan.repaid && (
              <p className="text-green-400 text-xs pt-1">This loan has already been repaid.</p>
            )}
          </div>
        )}

        <button
          onClick={handleRepay}
          disabled={repayStatus === "submitting" || !selectedLoan || selectedLoan.repaid}
          className="w-full bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed
                     text-white font-medium py-3 rounded-lg transition-colors text-sm"
        >
          {repayStatus === "submitting" ? (
            <>
              Repaying...
              <span className="ml-2 inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin align-middle" />
            </>
          ) : (
            "Repay loan"
          )}
        </button>

        {repayError && (
          <p className="text-sm text-red-400 border border-red-900 rounded-lg px-4 py-3">{repayError}</p>
        )}
        {repayStatus === "done" && (
          <p className="text-sm text-green-400">Loan repaid successfully.</p>
        )}
      </div>
    </div>
  );
}
