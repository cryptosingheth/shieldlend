"use client";

/**
 * StealthKeyContext — ERC-5564 Stealth Address Keys
 * ==================================================
 * Provides per-session stealth spend + view keys derived from a wallet signature.
 * Keys live in React state only — never persisted to localStorage or cookies.
 *
 * Usage:
 *   1. Wrap the app in <StealthKeyProvider>.
 *   2. Call useStealthKey() in any component.
 *   3. Call loadKeys() before a withdrawal — prompts MetaMask once per session.
 *      loadKeys() BOTH sets React state AND returns the values directly,
 *      because React setState is async and the caller needs the values immediately.
 *
 * Key derivation:
 *   - HKDF(SHA-256, walletSig) → 256 raw bits per role (spend, view)
 *   - deriveBits (not deriveKey) — secp256k1 needs raw bytes, not a CryptoKey
 *   - getPublicKey(privBytes, true) → compressed 33-byte secp256k1 pubkey
 *   - Meta-address URI: "st:eth:0x<spendPub_66chars><viewPub_66chars>" (141 chars)
 *     This is ERC-5564 Scheme 1 format.
 *
 * Why no ERC-5564 Announcer contract:
 *   The Announcer is for recipients scanning for funds sent by others.
 *   Here the user sends to themselves — they generated the ephemeral key and
 *   can immediately compute the stealth private key client-side. No scanning needed.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useSignMessage, useAccount } from "wagmi";
import { getPublicKey } from "@noble/secp256k1";

const SIGN_MESSAGE =
  "ShieldLend: derive stealth keys\n\nDerives withdrawal privacy keys. Never leaves your device.";

async function deriveStealthPrivKey(
  sigBuf: Buffer,
  address: string,
  role: "spend" | "view"
): Promise<string> {
  const base = await crypto.subtle.importKey("raw", sigBuf.buffer as ArrayBuffer, { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`shieldlend-stealth-${role}-${address.toLowerCase()}`),
      info: new TextEncoder().encode(`stealth-${role}-v1`),
    },
    base,
    256
  );
  return "0x" + Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

interface StealthKeyContextValue {
  stealthMetaAddressURI: string | null;
  spendingPrivateKey: string | null;
  viewingPrivateKey: string | null;
  isLoaded: boolean;
  isLoading: boolean;
  loadKeys: () => Promise<{ uri: string; spendKey: string; viewKey: string } | null>;
  error: string | null;
}

const StealthKeyContext = createContext<StealthKeyContextValue>({
  stealthMetaAddressURI: null,
  spendingPrivateKey: null,
  viewingPrivateKey: null,
  isLoaded: false,
  isLoading: false,
  loadKeys: async () => null,
  error: null,
});

export function StealthKeyProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [stealthMetaAddressURI, setStealthMetaAddressURI] = useState<string | null>(null);
  const [spendingPrivateKey, setSpendingPrivateKey] = useState<string | null>(null);
  const [viewingPrivateKey, setViewingPrivateKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = useCallback(async (): Promise<{ uri: string; spendKey: string; viewKey: string } | null> => {
    if (!address) { setError("Connect wallet first"); return null; }

    // Return cached keys without re-signing if already loaded this session
    if (stealthMetaAddressURI && spendingPrivateKey && viewingPrivateKey) {
      return { uri: stealthMetaAddressURI, spendKey: spendingPrivateKey, viewKey: viewingPrivateKey };
    }

    try {
      setIsLoading(true);
      setError(null);

      const sig = await signMessageAsync({ message: SIGN_MESSAGE });
      const sigBuf = Buffer.from(sig.slice(2), "hex");

      const spendKey = await deriveStealthPrivKey(sigBuf, address, "spend");
      const viewKey = await deriveStealthPrivKey(sigBuf, address, "view");

      // compressed 33-byte secp256k1 pubkeys from raw private key bytes
      const spendPub = getPublicKey(spendKey.slice(2), true);
      const viewPub = getPublicKey(viewKey.slice(2), true);
      const uri = `st:eth:0x${toHex(spendPub)}${toHex(viewPub)}`;

      setStealthMetaAddressURI(uri);
      setSpendingPrivateKey(spendKey);
      setViewingPrivateKey(viewKey);

      // Return values directly — React setState is async, caller needs them now
      return { uri, spendKey, viewKey };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signature rejected");
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [address, signMessageAsync, stealthMetaAddressURI, spendingPrivateKey, viewingPrivateKey]);

  return (
    <StealthKeyContext.Provider
      value={{
        stealthMetaAddressURI,
        spendingPrivateKey,
        viewingPrivateKey,
        isLoaded: stealthMetaAddressURI !== null,
        isLoading,
        loadKeys,
        error,
      }}
    >
      {children}
    </StealthKeyContext.Provider>
  );
}

export function useStealthKey(): StealthKeyContextValue {
  return useContext(StealthKeyContext);
}
