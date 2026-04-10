"use client";

/**
 * ViewingKeyContext — Auditor Disclosure Key
 * ===========================================
 * Provides a per-session AES-256-GCM CryptoKey for note history disclosure.
 * Unlike the note key (non-extractable, for spending), this key is extractable
 * so the user can export it as hex and share it with an auditor.
 *
 * Auditor capabilities with this key:
 *   - Decrypt note history (amounts, commitments, timestamps)
 *
 * Auditor CANNOT:
 *   - Generate ZK proofs (no nullifier or secret)
 *   - Spend funds
 *
 * Derived from a separate HKDF chain than the note key and stealth keys.
 * Same wallet → same viewing key every session (deterministic).
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useSignMessage, useAccount } from "wagmi";

const SIGN_MESSAGE =
  "ShieldLend: unlock viewing access\n\nAllows note history disclosure to auditors. Cannot spend funds.";

async function deriveViewingKey(sigBuf: Buffer, address: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", sigBuf.buffer as ArrayBuffer, { name: "HKDF" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`shieldlend-viewing-${address.toLowerCase()}`),
      info: new TextEncoder().encode("shieldlend-viewing-v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    true, // extractable — user can export hex to share with auditor
    ["encrypt", "decrypt"]
  );
}

interface ViewingKeyContextValue {
  viewingKey: CryptoKey | null;
  isLoaded: boolean;
  isLoading: boolean;
  loadKeys: () => Promise<CryptoKey | null>;
  exportKeyHex: () => Promise<string>;
  error: string | null;
}

const ViewingKeyContext = createContext<ViewingKeyContextValue>({
  viewingKey: null,
  isLoaded: false,
  isLoading: false,
  loadKeys: async () => null,
  exportKeyHex: async () => { throw new Error("ViewingKeyProvider not mounted"); },
  error: null,
});

export function ViewingKeyProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [viewingKey, setViewingKey] = useState<CryptoKey | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = useCallback(async (): Promise<CryptoKey | null> => {
    if (!address) { setError("Connect wallet first"); return null; }
    if (viewingKey) return viewingKey;

    try {
      setIsLoading(true);
      setError(null);
      const sig = await signMessageAsync({ message: SIGN_MESSAGE });
      const sigBuf = Buffer.from(sig.slice(2), "hex");
      const key = await deriveViewingKey(sigBuf, address);
      setViewingKey(key);
      return key;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signature rejected");
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [address, signMessageAsync, viewingKey]);

  const exportKeyHex = useCallback(async (): Promise<string> => {
    if (!viewingKey) throw new Error("Load viewing key first");
    const raw = await crypto.subtle.exportKey("raw", viewingKey);
    return Array.from(new Uint8Array(raw)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }, [viewingKey]);

  return (
    <ViewingKeyContext.Provider
      value={{
        viewingKey,
        isLoaded: viewingKey !== null,
        isLoading,
        loadKeys,
        exportKeyHex,
        error,
      }}
    >
      {children}
    </ViewingKeyContext.Provider>
  );
}

export function useViewingKey(): ViewingKeyContextValue {
  return useContext(ViewingKeyContext);
}
