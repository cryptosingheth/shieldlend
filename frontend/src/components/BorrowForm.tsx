"use client";

import { useState } from "react";
import { parseEther, formatEther } from "viem";
import { useAccount } from "wagmi";
import { type Address } from "viem";
import { deserializeNote, generateCollateralProof } from "@/lib/circuits";
import { useHasActiveLoan, fieldToBytes32 } from "@/lib/contracts";

const COLLATERAL_RATIO = 15000n; // 150% in BPS (10000 = 100%)

type ZkVerifyResult = {
  statement: string;
  aggregationId: number;
  statementPath: unknown;
  txHash: string;
};

export function BorrowForm() {
  const { address } = useAccount();
  const [noteJson, setNoteJson] = useState("");
  const [borrowEth, setBorrowEth] = useState("");
  const [status, setStatus] = useState<
    "idle" | "proving" | "zkverify" | "submitting" | "done" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);

  // Parse note to get nullifierHash for checking active loan
  let parsedNullifierHash: `0x${string}` | undefined;
  try {
    const parsed = noteJson ? JSON.parse(noteJson) : null;
    if (parsed?.nullifierHash) {
      parsedNullifierHash = ("0x" + parsed.nullifierHash) as `0x${string}`;
    }
  } catch {}

  const { data: hasLoan } = useHasActiveLoan(parsedNullifierHash);

  async function handleBorrow() {
    if (!noteJson.trim()) return setErrorMsg("Paste your note JSON");
    if (!borrowEth || isNaN(Number(borrowEth))) return setErrorMsg("Enter borrow amount");
    if (!address) return setErrorMsg("Connect wallet first");

    try {
      setErrorMsg("");
      const note = deserializeNote(noteJson);
      const borrowAmount = parseEther(borrowEth);

      // Collateral must be >= 150% of borrow amount
      if (note.amount * 10000n < COLLATERAL_RATIO * borrowAmount) {
        const minCollateral = formatEther((COLLATERAL_RATIO * borrowAmount) / 10000n);
        throw new Error(
          `Insufficient collateral. Need ${minCollateral} ETH, have ${formatEther(note.amount)} ETH`
        );
      }

      setStatus("proving");
      // collateral.circom proves: collateral * 10000 >= ratio * borrowed
      const { proof, publicSignals } = await generateCollateralProof(
        note.amount,
        borrowAmount,
        COLLATERAL_RATIO
      );

      setStatus("zkverify");
      const zkRes = await fetch("/api/zkverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circuit: "collateral", proof, publicSignals }),
      });
      if (!zkRes.ok) throw new Error(`zkVerify failed: ${await zkRes.text()}`);
      const zkResult: ZkVerifyResult = await zkRes.json();

      setStatus("submitting");
      // borrow() takes Groth16 proof components + noteNullifierHash + borrowed amount
      const res = await fetch("/api/borrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof,
          noteNullifierHash: fieldToBytes32(note.nullifierHash),
          borrowed: borrowAmount.toString(),
          recipient: address,
          zkVerifyAttestationId: zkResult.aggregationId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { txHash: borrowTx } = await res.json();
      setTxHash(borrowTx);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  }

  const isLoading = ["proving", "zkverify", "submitting"].includes(status);

  const statusLabel: Record<typeof status, string> = {
    idle: "Borrow",
    proving: "Generating collateral proof (~15s)...",
    zkverify: "Submitting to zkVerify...",
    submitting: "Confirming borrow...",
    done: "Borrowed!",
    error: "Borrow",
  };

  return (
    <div className="space-y-5">
      <div className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 text-xs text-zinc-400 space-y-1">
        <p>You prove collateral {">"} 150% of borrow amount using a ZK range proof.</p>
        <p>Your collateral amount is never revealed on-chain — only the proof.</p>
      </div>

      <div>
        <label className="block text-sm text-zinc-400 mb-2">Collateral note (from deposit)</label>
        <textarea
          value={noteJson}
          onChange={(e) => setNoteJson(e.target.value)}
          placeholder='{"nullifier":"...","secret":"...","amount":"...","commitment":"...","nullifierHash":"..."}'
          disabled={isLoading}
          rows={4}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-xs font-mono
                     focus:outline-none focus:border-indigo-500 disabled:opacity-50 resize-none transition-colors"
        />
        {hasLoan && (
          <p className="text-xs text-amber-400 mt-1">
            This note already has an active loan. Repay it first.
          </p>
        )}
      </div>

      <div>
        <label className="block text-sm text-zinc-400 mb-2">Borrow amount (ETH)</label>
        <input
          type="number"
          step="0.001"
          min="0"
          value={borrowEth}
          onChange={(e) => setBorrowEth(e.target.value)}
          placeholder="0.05"
          disabled={isLoading}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono
                     focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
        />
        {noteJson && borrowEth && (
          <p className="text-xs text-zinc-600 mt-1">
            Required collateral: {formatEther((COLLATERAL_RATIO * parseEther(borrowEth || "0")) / 10000n)} ETH (150%)
          </p>
        )}
      </div>

      <button
        onClick={handleBorrow}
        disabled={isLoading || !noteJson || !borrowEth || !!hasLoan}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed
                   text-white font-medium py-3 rounded-lg transition-colors text-sm"
      >
        {statusLabel[status]}
        {isLoading && (
          <span className="ml-2 inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin align-middle" />
        )}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-400 border border-red-900 rounded-lg px-4 py-3">{errorMsg}</p>
      )}
      {status === "done" && txHash && (
        <p className="text-sm text-green-400">
          Loan disbursed · tx: {txHash.slice(0, 10)}...
        </p>
      )}
    </div>
  );
}
