"use client";

import { useState, useEffect } from "react";
import { parseEther, formatEther } from "viem";
import { usePublicClient, useSendTransaction } from "wagmi";
import { createNote, serializeNote } from "@/lib/circuits";
import { fieldToBytes32 } from "@/lib/contracts";
import { saveNote } from "@/lib/noteStorage";
import { useAccount } from "wagmi";
import { useNoteKey } from "@/lib/noteKeyContext";
import { useViewingKey } from "@/lib/viewingKeyContext";

const RELAY_ADDRESS = process.env.NEXT_PUBLIC_RELAY_ADDRESS as `0x${string}`;
// Gas limit for ShieldedPool.deposit() (Merkle insertion + event emit). Padded 2× for safety.
const RELAY_GAS_LIMIT = 300_000n;

type DepositStatus = "idle" | "generating" | "sending" | "sent" | "relaying" | "confirming" | "done" | "error";

export function DepositForm() {
  const { address } = useAccount();
  const { noteKey } = useNoteKey();
  const { viewingKey, loadKeys: loadViewingKey, isLoading: viewingKeyLoading } = useViewingKey();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const DENOMINATIONS = ["0.001", "0.005", "0.01", "0.05", "0.1", "0.5"];
  const [amountEth, setAmountEth] = useState("");
  const [gasBuffer, setGasBuffer] = useState<bigint>(0n);
  const [status, setStatus] = useState<DepositStatus>("idle");
  const [noteDisplay, setNoteDisplay] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Estimate relay gas fee whenever denomination changes
  useEffect(() => {
    if (!amountEth || !publicClient) { setGasBuffer(0n); return; }
    let cancelled = false;
    publicClient.getGasPrice().then((gasPrice) => {
      if (!cancelled) setGasBuffer(gasPrice * RELAY_GAS_LIMIT);
    }).catch(() => { if (!cancelled) setGasBuffer(0n); });
    return () => { cancelled = true; };
  }, [amountEth, publicClient]);

  async function handleDeposit() {
    if (!amountEth) {
      setErrorMsg("Select a denomination");
      return;
    }
    if (!publicClient) {
      setErrorMsg("No public client — connect wallet");
      return;
    }
    if (!RELAY_ADDRESS) {
      setErrorMsg("Relay address not configured");
      return;
    }

    try {
      setStatus("generating");
      setErrorMsg("");
      setNoteDisplay(null);

      const amount = parseEther(amountEth);
      const newNote = await createNote(amount);
      const serialized = serializeNote(newNote);

      // Show note immediately so user can back it up while tx is in-flight
      setNoteDisplay(serialized);

      // Step 1: User sends (amount + gasBuffer) to relay.
      // The extra gasBuffer covers the relay's cost to forward to ShieldedPool.
      // amount is the deposit; gasBuffer is pre-paid relay fee.
      setStatus("sending");
      const currentGasPrice = await publicClient.getGasPrice();
      const currentGasBuffer = currentGasPrice * RELAY_GAS_LIMIT;
      const userTxHash = await sendTransactionAsync({
        to: RELAY_ADDRESS,
        value: amount + currentGasBuffer,
      });

      setStatus("sent");
      await publicClient.waitForTransactionReceipt({ hash: userTxHash });

      // Feature D: Encrypt note data with viewing key for on-chain recovery.
      // Binary-packed format: nullifier(32B) + secret(32B) + amount(8B) = 72B plaintext
      // AES-GCM output: IV(12B) + ciphertext+tag(88B) = 100B — well under the 256B contract cap.
      // commitment and nullifierHash are omitted; they are Poseidon-derivable from nullifier+secret+amount.
      let encryptedNote: string | undefined;
      if (viewingKey) {
        try {
          // Pack: nullifier (32 bytes BE) | secret (32 bytes BE) | amount (8 bytes BE uint64)
          const plain = new Uint8Array(72);
          const writeU256 = (offset: number, v: bigint) => {
            for (let i = 0; i < 32; i++) { plain[offset + 31 - i] = Number(v & 0xffn); v >>= 8n; }
          };
          writeU256(0, newNote.nullifier);
          writeU256(32, newNote.secret);
          const amt = newNote.amount;
          for (let i = 0; i < 8; i++) plain[64 + 7 - i] = Number((amt >> BigInt(i * 8)) & 0xffn);

          const iv = crypto.getRandomValues(new Uint8Array(12));
          const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, viewingKey, plain);
          const combined = new Uint8Array(iv.length + cipherBuf.byteLength); // 12 + 88 = 100 bytes
          combined.set(iv);
          combined.set(new Uint8Array(cipherBuf), iv.length);
          encryptedNote = "0x" + Array.from(combined).map(b => b.toString(16).padStart(2, "0")).join("");
        } catch {
          // Non-fatal: if encryption fails, deposit proceeds with empty note bytes
        }
      }

      // Step 2: Relay forwards the ETH + commitment to ShieldedPool.
      // The relay's wallet is the msg.sender — user's address never touches the pool.
      setStatus("relaying");
      const res = await fetch("/api/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitment: fieldToBytes32(newNote.commitment),
          denomination: amount.toString(),
          encryptedNote,
        }),
      });
      if (!res.ok) throw new Error(`Deposit failed: ${await res.text()}`);
      const { txHash } = await res.json();

      setStatus("confirming");
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Save note to vault after on-chain confirmation
      if (address) {
        await saveNote(address, newNote, noteKey, txHash);
        // Notify WithdrawForm (same tab) to reload notes immediately
        window.dispatchEvent(new CustomEvent("shieldlend:noteAdded"));
      }
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setNoteDisplay(null);
    }
  }

  const isLoading = ["generating", "sending", "sent", "relaying", "confirming"].includes(status);

  const buttonLabel =
    status === "generating" ? "Creating note..."
    : status === "sending" ? "Confirm in MetaMask..."
    : status === "sent" ? "Waiting for transfer..."
    : status === "relaying" ? "Relaying to pool..."
    : status === "confirming" ? "Confirming on-chain..."
    : "Deposit";

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

      {/* Relay fee breakdown — shown when denomination is selected */}
      {amountEth && !isLoading && status !== "done" && (
        <div className="text-xs text-zinc-500 space-y-1 border border-zinc-800 rounded-lg px-3 py-2">
          <div className="flex justify-between">
            <span>Deposit amount</span>
            <span className="font-mono text-zinc-300">{amountEth} ETH</span>
          </div>
          <div className="flex justify-between">
            <span>Relay fee (gas estimate)</span>
            <span className="font-mono text-zinc-400">
              {gasBuffer > 0n ? `~${parseFloat(formatEther(gasBuffer)).toFixed(7)} ETH` : "estimating..."}
            </span>
          </div>
          <div className="flex justify-between border-t border-zinc-800 pt-1 text-zinc-300">
            <span>Total you will send</span>
            <span className="font-mono">
              {gasBuffer > 0n
                ? `~${parseFloat(formatEther(parseEther(amountEth) + gasBuffer)).toFixed(7)} ETH`
                : `${amountEth} ETH`}
            </span>
          </div>
        </div>
      )}

      {/* Feature D: viewing key prompt — enables on-chain encrypted note recovery */}
      {!viewingKey && !isLoading && (
        <div className="border border-zinc-700 rounded-lg px-3 py-2 flex items-center justify-between gap-3 text-xs">
          <span className="text-zinc-400">
            Enable <span className="text-indigo-400">encrypted note recovery</span> — stores a viewing-key cipher on-chain so you can recover notes from any device.
          </span>
          <button
            type="button"
            disabled={viewingKeyLoading}
            onClick={() => loadViewingKey()}
            className="shrink-0 text-indigo-400 hover:text-indigo-300 underline disabled:opacity-50 whitespace-nowrap"
          >
            {viewingKeyLoading ? "Signing..." : "Load key"}
          </button>
        </div>
      )}
      {viewingKey && !isLoading && (
        <p className="text-xs text-green-500/70">Viewing key loaded — note will be encrypted on-chain.</p>
      )}

      <button
        onClick={handleDeposit}
        disabled={isLoading || !amountEth || !DENOMINATIONS.includes(amountEth)}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed
                   text-white font-medium py-3 rounded-lg transition-colors text-sm"
      >
        {buttonLabel}
        {isLoading && (
          <span className="ml-2 inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin align-middle" />
        )}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-400 border border-red-900 rounded-lg px-4 py-3">
          {errorMsg}
        </p>
      )}

      {/* Show note while tx is in-flight — user should back it up now */}
      {noteDisplay && status !== "done" && (
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

      {status === "done" && (
        <div className="border border-green-800 rounded-lg p-4 bg-green-950/20 space-y-1">
          <p className="text-sm text-green-400 font-medium">Deposit confirmed — note saved to vault.</p>
          <p className="text-xs text-zinc-400">
            Go to <span className="text-indigo-400 font-medium">Withdraw</span> when you are ready.
            Your note will be available after the next epoch flush (~50 blocks).
          </p>
          <p className="text-xs text-zinc-600">
            Deposited privately — your wallet address is not visible on-chain.
          </p>
        </div>
      )}
    </div>
  );
}
