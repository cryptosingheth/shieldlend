"use client";

import { useState } from "react";
import { parseEther } from "viem";
import { useDeposit } from "@/lib/contracts";
import { createNote, serializeNote, fieldToBytes32 } from "@/lib/circuits";

export function DepositForm() {
  const [amountEth, setAmountEth] = useState("");
  const [status, setStatus] = useState<"idle" | "generating" | "submitting" | "done" | "error">(
    "idle"
  );
  const [note, setNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const { deposit, isPending, isConfirming, isSuccess } = useDeposit();

  async function handleDeposit() {
    if (!amountEth || isNaN(Number(amountEth)) || Number(amountEth) <= 0) {
      setErrorMsg("Enter a valid ETH amount");
      return;
    }

    try {
      setStatus("generating");
      setErrorMsg("");

      const amount = parseEther(amountEth);
      // createNote generates random nullifier + secret and computes commitment
      const newNote = await createNote(amount);
      const serialized = serializeNote(newNote);
      const commitment = fieldToBytes32(newNote.commitment);

      // Save note immediately — user must back this up
      setNote(serialized);
      localStorage.setItem(`shieldlend_note_${commitment}`, serialized);

      setStatus("submitting");
      deposit(commitment, amount);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  }

  const isLoading = isPending || isConfirming || status === "generating";

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm text-zinc-400 mb-2">Amount (ETH)</label>
        <input
          type="number"
          step="0.001"
          min="0"
          value={amountEth}
          onChange={(e) => setAmountEth(e.target.value)}
          placeholder="0.1"
          disabled={isLoading}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm font-mono
                     focus:outline-none focus:border-indigo-500 disabled:opacity-50 transition-colors"
        />
      </div>

      <button
        onClick={handleDeposit}
        disabled={isLoading || !amountEth}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed
                   text-white font-medium py-3 rounded-lg transition-colors text-sm"
      >
        {status === "generating"
          ? "Creating note..."
          : isPending
          ? "Confirm in wallet..."
          : isConfirming
          ? "Confirming..."
          : "Deposit"}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-400 border border-red-900 rounded-lg px-4 py-3">
          {errorMsg}
        </p>
      )}

      {note && (
        <div className="border border-amber-800 rounded-lg p-4 bg-amber-950/30">
          <p className="text-amber-400 text-xs font-semibold mb-2 uppercase tracking-wider">
            Save your note — you cannot recover it
          </p>
          <textarea
            readOnly
            value={note}
            className="w-full bg-transparent text-xs font-mono text-zinc-300 resize-none h-24
                       border border-zinc-800 rounded p-2 focus:outline-none"
          />
          <p className="text-xs text-zinc-500 mt-2">
            This note is your proof of deposit. Store it securely — losing it means losing access
            to your funds.
          </p>
        </div>
      )}

      {isSuccess && (
        <p className="text-sm text-green-400">
          Deposit confirmed. Your funds are now in the shielded pool.
        </p>
      )}
    </div>
  );
}
