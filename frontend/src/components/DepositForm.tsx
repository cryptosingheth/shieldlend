"use client";

import { useState, useEffect, useRef } from "react";
import { parseEther } from "viem";
import { useBlockNumber } from "wagmi";
import { useDeposit, useEpochStatus } from "@/lib/contracts";
import { createNote, serializeNote, type Note } from "@/lib/circuits";
import { fieldToBytes32 } from "@/lib/contracts";
import { saveNote } from "@/lib/noteStorage";
import { useAccount } from "wagmi";
import { useNoteKey } from "@/lib/noteKeyContext";

export function DepositForm() {
  const { address } = useAccount();
  const { noteKey } = useNoteKey();
  const { lastEpochBlock, epochBlocks } = useEpochStatus();
  const { data: currentBlock } = useBlockNumber({ watch: true });
  const DENOMINATIONS = ["0.001", "0.005", "0.01", "0.05", "0.1", "0.5"];
  const [amountEth, setAmountEth] = useState("");
  const [status, setStatus] = useState<"idle" | "generating" | "submitting" | "done" | "error">(
    "idle"
  );
  const [noteDisplay, setNoteDisplay] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Hold pending note in a ref — survives re-renders, cleared after vault save
  const pendingNote = useRef<Note | null>(null);

  const { deposit, hash, isPending, isConfirming, isSuccess } = useDeposit();

  // Save note to vault ONLY after tx is confirmed on-chain
  useEffect(() => {
    if (isSuccess && pendingNote.current && address) {
      saveNote(address, pendingNote.current, noteKey, hash);
      pendingNote.current = null;
      setStatus("done");
    }
  }, [isSuccess, address, hash, noteKey]);

  async function handleDeposit() {
    if (!amountEth) {
      setErrorMsg("Select a denomination");
      return;
    }

    try {
      setStatus("generating");
      setErrorMsg("");

      const amount = parseEther(amountEth);
      const newNote = await createNote(amount);
      const serialized = serializeNote(newNote);

      // Show note immediately so user can back it up while tx is in-flight
      setNoteDisplay(serialized);
      // Store in ref — saved to vault only after tx confirms
      pendingNote.current = newNote;

      setStatus("submitting");
      await deposit(fieldToBytes32(newNote.commitment), amount);
      // Note: vault save happens in the useEffect above when isSuccess fires
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      // Tx was rejected/failed — discard pending note, it was never deposited
      pendingNote.current = null;
      setNoteDisplay(null);
    }
  }

  const isLoading = isPending || isConfirming || status === "generating";

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm text-zinc-400 mb-2">Amount (ETH)</label>
        <div className="grid grid-cols-3 gap-2">
          {DENOMINATIONS.map((d) => (
            <button
              key={d}
              type="button"
              disabled={isLoading}
              onClick={() => setAmountEth(d)}
              className={`py-2 rounded-lg text-sm font-mono border transition-colors disabled:opacity-50
                ${amountEth === d
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-indigo-500"
                }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={handleDeposit}
        disabled={isLoading || !amountEth || !DENOMINATIONS.includes(amountEth)}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed
                   text-white font-medium py-3 rounded-lg transition-colors text-sm"
      >
        {status === "generating"
          ? "Creating note..."
          : isPending
          ? "Confirm in wallet..."
          : isConfirming
          ? "Confirming on-chain..."
          : "Deposit"}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-400 border border-red-900 rounded-lg px-4 py-3">
          {errorMsg}
        </p>
      )}

      {/* Show note while tx is in-flight — user should back it up now */}
      {noteDisplay && !isSuccess && (
        <div className="border border-amber-800 rounded-lg p-4 bg-amber-950/30">
          <p className="text-amber-400 text-xs font-semibold mb-2 uppercase tracking-wider">
            Back up your note now — waiting for confirmation
          </p>
          <textarea
            readOnly
            value={noteDisplay}
            className="w-full bg-transparent text-xs font-mono text-zinc-300 resize-none h-24
                       border border-zinc-800 rounded p-2 focus:outline-none"
          />
          <p className="text-xs text-zinc-500 mt-2">
            Copy this note before the transaction confirms. It will be auto-saved to your vault
            once confirmed.
          </p>
        </div>
      )}

      {isSuccess && (() => {
        // Compute how many blocks remain until this deposit can be flushed into the tree.
        // lastEpochBlock is updated by the contract after each flush.
        // After a deposit, lastEpochBlock still reflects the previous flush,
        // so blocksRemaining = (lastEpochBlock + EPOCH_BLOCKS) - currentBlock.
        const flushAtBlock =
          lastEpochBlock !== undefined && epochBlocks !== undefined
            ? lastEpochBlock + epochBlocks
            : undefined;
        const blocksLeft =
          flushAtBlock !== undefined && currentBlock !== undefined
            ? Number(flushAtBlock) - Number(currentBlock)
            : undefined;
        const canFlushNow = blocksLeft !== undefined && blocksLeft <= 0;
        const secsLeft = blocksLeft !== undefined && blocksLeft > 0 ? blocksLeft * 2 : 0;

        return (
          <div className="border border-green-800 rounded-lg p-4 bg-green-950/20 space-y-2">
            <p className="text-sm text-green-400 font-medium">Deposit confirmed — queued for Merkle insertion.</p>
            {canFlushNow ? (
              <p className="text-xs text-zinc-400">
                The epoch is ready to flush. Go to{" "}
                <span className="text-indigo-400 font-medium">Withdraw</span>, select this note,
                and click <span className="font-medium text-amber-400">Flush Epoch</span> to insert
                it into the Merkle tree before withdrawing.
              </p>
            ) : (
              <p className="text-xs text-zinc-400">
                Withdrawal will be available in approximately{" "}
                <span className="text-white font-medium">
                  {blocksLeft !== undefined ? `${blocksLeft} blocks` : "~50 blocks"}
                </span>{" "}
                (~{secsLeft > 0 ? `${secsLeft}s` : "soon"} on Base Sepolia).
                Your note is saved — come back once the epoch flushes.
              </p>
            )}
            <p className="text-xs text-zinc-600">
              This delay is intentional: deposits are batched and shuffled together for privacy.
            </p>
          </div>
        );
      })()}
    </div>
  );
}
