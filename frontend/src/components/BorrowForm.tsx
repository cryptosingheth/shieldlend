"use client";

import { useState, useEffect } from "react";
import { parseEther, formatEther } from "viem";
import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { type Address } from "viem";
import { deserializeNote, generateCollateralProof } from "@/lib/circuits";
import { useHasActiveLoan, useLoanDetails, fieldToBytes32, LENDING_POOL_ADDRESS, LENDING_POOL_ABI } from "@/lib/contracts";
import { loadNotes, storedNoteToNote, noteLabel, type StoredNote } from "@/lib/noteStorage";

const COLLATERAL_RATIO = 15000n; // 150% in BPS

// Health factor color: green > 2.0, yellow 1.5–2.0, red < 1.5
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

export function BorrowForm() {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  // ── Note selection ────────────────────────────────────────────────────────
  const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
  const [selectedNullifierHash, setSelectedNullifierHash] = useState<string>("");
  const [noteJson, setNoteJson] = useState(""); // fallback manual paste

  // Load saved notes on mount / address change
  useEffect(() => {
    if (address) setSavedNotes(loadNotes(address).filter((n) => !n.spent));
  }, [address]);

  const selectedNote = savedNotes.find((n) => n.nullifierHash === selectedNullifierHash);

  // ── Borrow state ──────────────────────────────────────────────────────────
  const [borrowEth, setBorrowEth] = useState("");
  const [borrowStatus, setBorrowStatus] = useState<
    "idle" | "proving" | "zkverify" | "submitting" | "done" | "error"
  >("idle");
  const [borrowError, setBorrowError] = useState("");
  const [borrowTxHash, setBorrowTxHash] = useState<string | null>(null);

  // ── Repay state ───────────────────────────────────────────────────────────
  const [repayLoanId, setRepayLoanId] = useState<string>("");
  const [repayStatus, setRepayStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [repayError, setRepayError] = useState("");

  // ── Contract read hooks ───────────────────────────────────────────────────
  const nullifierHashHex =
    selectedNote?.nullifierHash ??
    (noteJson ? (() => { try { return fieldToBytes32(deserializeNote(noteJson).nullifierHash); } catch { return undefined; } })() : undefined);

  const { data: hasLoan } = useHasActiveLoan(nullifierHashHex as `0x${string}` | undefined);

  const repayLoanIdBig = repayLoanId && !isNaN(Number(repayLoanId))
    ? BigInt(repayLoanId)
    : undefined;
  const { data: loanDetails } = useLoanDetails(repayLoanIdBig);

  // ── Repay wagmi hooks ─────────────────────────────────────────────────────
  const { writeContractAsync } = useWriteContract();

  // ── Derived: health factor preview ───────────────────────────────────────
  const noteForCalc = selectedNote
    ? storedNoteToNote(selectedNote)
    : (() => { try { return deserializeNote(noteJson); } catch { return null; } })();

  const collateral = noteForCalc?.amount ?? 0n;
  const borrowWei = borrowEth ? (() => { try { return parseEther(borrowEth); } catch { return 0n; } })() : 0n;
  const healthFactor =
    borrowWei > 0n && collateral > 0n
      ? Number((collateral * 10000n) / (COLLATERAL_RATIO * borrowWei / 10000n)) / 10000
      : null;

  const maxBorrowable = collateral > 0n
    ? formatEther((collateral * 10000n) / COLLATERAL_RATIO)
    : null;

  // ── Borrow handler ────────────────────────────────────────────────────────
  async function handleBorrow() {
    const note = noteForCalc;
    if (!note) return setBorrowError("Select a note or paste JSON");
    if (!borrowEth || isNaN(Number(borrowEth))) return setBorrowError("Enter borrow amount");
    if (!address) return setBorrowError("Connect wallet first");

    try {
      setBorrowError("");
      const borrowAmount = parseEther(borrowEth);

      if (note.amount * 10000n < COLLATERAL_RATIO * borrowAmount) {
        const minCollateral = formatEther((COLLATERAL_RATIO * borrowAmount) / 10000n);
        throw new Error(`Insufficient collateral. Need ${minCollateral} ETH, have ${formatEther(note.amount)} ETH`);
      }

      setBorrowStatus("proving");
      const { proof, publicSignals } = await generateCollateralProof(
        note.amount,
        borrowAmount,
        COLLATERAL_RATIO
      );

      setBorrowStatus("zkverify");
      const zkRes = await fetch("/api/zkverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circuit: "collateral", proof, publicSignals }),
      });
      if (!zkRes.ok) throw new Error(`zkVerify failed: ${await zkRes.text()}`);
      const zkResult = await zkRes.json();

      setBorrowStatus("submitting");
      const res = await fetch("/api/borrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof,
          publicSignals,
          noteNullifierHash: fieldToBytes32(note.nullifierHash),
          borrowed: borrowAmount.toString(),
          recipient: address,
          zkVerifyAttestationId: zkResult.aggregationId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { txHash } = await res.json();
      setBorrowTxHash(txHash);
      setBorrowStatus("done");
    } catch (err) {
      setBorrowStatus("error");
      setBorrowError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  // ── Repay handler ─────────────────────────────────────────────────────────
  async function handleRepay() {
    if (!loanDetails) return setRepayError("Load loan details first");
    try {
      setRepayError("");
      setRepayStatus("submitting");
      // loanDetails is a named tuple: [collateralNullifierHash, borrowed, currentInterest, totalOwed, repaid]
      const d = loanDetails as unknown as { totalOwed: bigint };
      const totalOwed = d.totalOwed;
      await writeContractAsync({
        address: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: "repay",
        args: [repayLoanIdBig!],
        value: totalOwed,
      });
      setRepayStatus("done");
    } catch (err) {
      setRepayStatus("error");
      setRepayError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  const isBorrowing = ["proving", "zkverify", "submitting"].includes(borrowStatus);

  const borrowLabel: Record<typeof borrowStatus, string> = {
    idle: "Borrow",
    proving: "Generating collateral proof (~15s)...",
    zkverify: "Submitting to zkVerify...",
    submitting: "Confirming borrow...",
    done: "Borrowed",
    error: "Borrow",
  };

  return (
    <div className="space-y-8">

      {/* ── Borrow section ────────────────────────────────────────────────── */}
      <div className="space-y-5">
        <div className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 text-xs text-zinc-400 space-y-1">
          <p>Prove collateral &gt; 150% of borrow amount using a ZK range proof.</p>
          <p>Your collateral amount is never revealed on-chain — only the proof.</p>
        </div>

        {/* Note selection */}
        <div>
          <label className="block text-sm text-zinc-400 mb-2">Collateral note</label>
          {savedNotes.length > 0 ? (
            <select
              value={selectedNullifierHash}
              onChange={(e) => { setSelectedNullifierHash(e.target.value); setNoteJson(""); }}
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

          {/* Collateral summary */}
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

          {/* Health factor preview */}
          {healthFactor !== null && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Health factor:</span>
              <span className={`font-semibold font-mono ${healthColor(healthFactor)}`}>
                {healthFactor.toFixed(2)}
              </span>
              <span className={`${healthColor(healthFactor)}`}>
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
          <p className="text-sm text-green-400">
            Loan disbursed · tx: {borrowTxHash.slice(0, 10)}...
          </p>
        )}
      </div>

      {/* ── Divider ────────────────────────────────────────────────────────── */}
      <div className="border-t border-zinc-800" />

      {/* ── Repay section ─────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-300">Repay a loan</h3>

        <div>
          <label className="block text-sm text-zinc-400 mb-2">Loan ID</label>
          <input
            type="number"
            min="0"
            value={repayLoanId}
            onChange={(e) => setRepayLoanId(e.target.value)}
            placeholder="0"
            disabled={repayStatus === "submitting"}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono
                       focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
          />
        </div>

        {/* Loan details */}
        {loanDetails && (
          <div className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 text-xs space-y-2">
            {(() => {
              const d = loanDetails as unknown as {
                borrowed: bigint;
                currentInterest: bigint;
                totalOwed: bigint;
                repaid: boolean;
              };
              return (
                <>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Principal</span>
                    <span className="font-mono text-zinc-200">{formatEther(d.borrowed)} ETH</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Accrued interest</span>
                    <span className="font-mono text-zinc-200">{formatEther(d.currentInterest)} ETH</span>
                  </div>
                  <div className="flex justify-between border-t border-zinc-800 pt-2">
                    <span className="text-zinc-400 font-medium">Total owed</span>
                    <span className="font-mono text-white font-semibold">{formatEther(d.totalOwed)} ETH</span>
                  </div>
                  {d.repaid && (
                    <p className="text-green-400 text-xs pt-1">This loan has already been repaid.</p>
                  )}
                </>
              );
            })()}
          </div>
        )}

        <button
          onClick={handleRepay}
          disabled={repayStatus === "submitting" || !loanDetails || !!(loanDetails as unknown as { repaid: boolean }).repaid}
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
