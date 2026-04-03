"use client";

/**
 * NoteKeyContext — V2 Session Encryption Key
 * ============================================
 * Provides a per-session AES-256-GCM CryptoKey derived from a wallet signature.
 *
 * Usage:
 *   1. Wrap the app in <NoteKeyProvider>.
 *   2. In any component call useNoteKey() to get { noteKey, deriveKey, isUnlocked }.
 *   3. Call deriveKey() once after wallet connect — prompts a MetaMask signature.
 *   4. Pass noteKey to loadNotes / saveNote / markNoteSpent.
 *
 * The CryptoKey is non-extractable (marked extractable: false in HKDF) so it
 * cannot be serialised or stolen from memory by page scripts.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useSignMessage, useAccount } from "wagmi";
import { deriveNoteKey } from "./noteStorage";

const SIGN_MESSAGE =
  "ShieldLend: unlock note vault\n\nThis signature is used only to derive your local encryption key. It never leaves your device.";

interface NoteKeyContextValue {
  noteKey: CryptoKey | null;
  isUnlocked: boolean;
  isUnlocking: boolean;
  unlock: () => Promise<void>;
  lock: () => void;
  error: string | null;
}

const NoteKeyContext = createContext<NoteKeyContextValue>({
  noteKey: null,
  isUnlocked: false,
  isUnlocking: false,
  unlock: async () => {},
  lock: () => {},
  error: null,
});

export function NoteKeyProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [noteKey, setNoteKey] = useState<CryptoKey | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = useCallback(async () => {
    if (!address) { setError("Connect wallet first"); return; }
    try {
      setIsUnlocking(true);
      setError(null);

      // Deterministic sig — same wallet + same message = same bytes every session
      const sig = await signMessageAsync({ message: SIGN_MESSAGE });

      // Hex sig → raw bytes for HKDF key material
      const sigBytes = Buffer.from(sig.slice(2), "hex");
      const key = await deriveNoteKey(sigBytes, address);

      setNoteKey(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signature rejected");
    } finally {
      setIsUnlocking(false);
    }
  }, [address, signMessageAsync]);

  const lock = useCallback(() => {
    setNoteKey(null);
    setError(null);
  }, []);

  return (
    <NoteKeyContext.Provider
      value={{
        noteKey,
        isUnlocked: noteKey !== null,
        isUnlocking,
        unlock,
        lock,
        error,
      }}
    >
      {children}
    </NoteKeyContext.Provider>
  );
}

export function useNoteKey(): NoteKeyContextValue {
  return useContext(NoteKeyContext);
}
