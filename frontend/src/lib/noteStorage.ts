/**
 * ShieldLend Note Storage — V2
 * =============================
 * Stores deposit notes in browser localStorage with AES-256-GCM encryption.
 *
 * Key derivation:
 *   1. User signs a fixed message with MetaMask → deterministic bytes per address.
 *   2. HKDF(SHA-256) derives a 256-bit AES-GCM key from those bytes.
 *   3. Each note record is encrypted individually (fresh IV per write).
 *
 * Security model:
 *   - XSS cannot extract notes without triggering a wallet signature.
 *   - localStorage forensics yields only ciphertext.
 *   - The key is ephemeral (only in memory for the session).
 *   - A null key falls back to unencrypted plaintext (testnet-only path).
 *
 * Key structure: `shieldlend_notes_<address>` → JSON array of EncryptedNote | StoredNote
 */

import { type Note } from "./circuits";
import { fieldToBytes32 } from "./contracts";

export interface StoredNote {
  nullifierHash: string;     // hex — primary key
  commitment: string;        // hex — used to find deposit event on-chain
  nullifier: string;         // hex — private, never leaves localStorage
  secret: string;            // hex — private, never leaves localStorage
  amount: string;            // decimal string (wei)
  depositTx?: string;        // on-chain tx hash if available
  depositedAt: number;       // unix ms timestamp
  spent: boolean;            // true after successful withdrawal
  label?: string;            // optional user-set label
  viewingCipher?: { iv: string; ct: string }; // note re-encrypted with viewing key for auditor disclosure
}

/** Encrypted wrapper stored in localStorage when a key is present */
interface EncryptedNote {
  _enc: true;
  iv: string;          // hex-encoded 12-byte IV
  ct: string;          // hex-encoded ciphertext
}

type NoteRecord = StoredNote | EncryptedNote;

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers (Web Crypto API — available in all modern browsers)
// ─────────────────────────────────────────────────────────────────────────────

/** Derive an AES-256-GCM CryptoKey from arbitrary bytes via HKDF. */
export async function deriveNoteKey(
  keyMaterial: Uint8Array,
  address: string
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial.buffer as ArrayBuffer,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  const salt = new TextEncoder().encode(`shieldlend-note-salt-${address.toLowerCase()}`);
  const info = new TextEncoder().encode("shieldlend-note-encryption-v2");

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptNote(note: StoredNote, key: CryptoKey): Promise<EncryptedNote> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(note));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return {
    _enc: true,
    iv: Buffer.from(iv).toString("hex"),
    ct: Buffer.from(ct).toString("hex"),
  };
}

async function decryptNote(record: EncryptedNote, key: CryptoKey): Promise<StoredNote> {
  const iv = Buffer.from(record.iv, "hex");
  const ct = Buffer.from(record.ct, "hex");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plaintext)) as StoredNote;
}

function isEncrypted(r: NoteRecord): r is EncryptedNote {
  return (r as EncryptedNote)._enc === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage key
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = (address: string) =>
  `shieldlend_notes_${address.toLowerCase()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Read / Write (async — key may be null for plaintext fallback)
// ─────────────────────────────────────────────────────────────────────────────

export async function loadNotes(
  address: string,
  key: CryptoKey | null = null
): Promise<StoredNote[]> {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY(address));
    if (!raw) return [];
    const records = JSON.parse(raw) as NoteRecord[];

    const notes: StoredNote[] = [];
    for (const r of records) {
      if (isEncrypted(r)) {
        if (!key) continue; // skip encrypted records when no key
        try {
          notes.push(await decryptNote(r, key));
        } catch {
          // Decryption failure — wrong key or corrupted record; skip silently
        }
      } else {
        notes.push(r as StoredNote);
      }
    }
    return notes;
  } catch {
    return [];
  }
}

export async function saveNote(
  address: string,
  note: Note,
  key: CryptoKey | null = null,
  depositTx?: string
): Promise<StoredNote> {
  const stored: StoredNote = {
    nullifierHash: fieldToBytes32(note.nullifierHash),
    commitment: fieldToBytes32(note.commitment),
    nullifier: note.nullifier.toString(16),
    secret: note.secret.toString(16),
    amount: note.amount.toString(),
    depositTx,
    depositedAt: Date.now(),
    spent: false,
  };

  const raw = localStorage.getItem(STORAGE_KEY(address));
  const existing: NoteRecord[] = raw ? (JSON.parse(raw) as NoteRecord[]) : [];

  // Remove any existing record with the same nullifierHash (plaintext or encrypted)
  const withoutDup: NoteRecord[] = [];
  for (const r of existing) {
    if (isEncrypted(r)) {
      withoutDup.push(r); // keep — can't inspect without key
    } else {
      if ((r as StoredNote).nullifierHash !== stored.nullifierHash) withoutDup.push(r);
    }
  }

  const toStore: NoteRecord = key ? await encryptNote(stored, key) : stored;
  localStorage.setItem(STORAGE_KEY(address), JSON.stringify([toStore, ...withoutDup]));
  return stored;
}

export async function markNoteSpent(
  address: string,
  nullifierHash: string,
  key: CryptoKey | null = null
): Promise<void> {
  const notes = await loadNotes(address, key);
  const updated = notes.map((n) =>
    n.nullifierHash.toLowerCase() === nullifierHash.toLowerCase()
      ? { ...n, spent: true }
      : n
  );

  if (key) {
    const encrypted = await Promise.all(updated.map((n) => encryptNote(n, key)));
    localStorage.setItem(STORAGE_KEY(address), JSON.stringify(encrypted));
  } else {
    localStorage.setItem(STORAGE_KEY(address), JSON.stringify(updated));
  }
}

export async function deleteNote(
  address: string,
  nullifierHash: string,
  key: CryptoKey | null = null
): Promise<void> {
  const notes = await loadNotes(address, key);
  const filtered = notes.filter(
    (n) => n.nullifierHash.toLowerCase() !== nullifierHash.toLowerCase()
  );

  if (key) {
    const encrypted = await Promise.all(filtered.map((n) => encryptNote(n, key)));
    localStorage.setItem(STORAGE_KEY(address), JSON.stringify(encrypted));
  } else {
    localStorage.setItem(STORAGE_KEY(address), JSON.stringify(filtered));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a StoredNote back to a Note (bigint fields) for proof generation */
export function storedNoteToNote(s: StoredNote): Note {
  return {
    nullifier: BigInt("0x" + s.nullifier),
    secret: BigInt("0x" + s.secret),
    amount: BigInt(s.amount),
    commitment: BigInt(s.commitment),
    nullifierHash: BigInt(s.nullifierHash),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewing key helpers — auditor disclosure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-encrypt a note with the viewing key so auditors can read it.
 * The result is stored in note.viewingCipher alongside the normal encryption.
 * Auditors cannot generate ZK proofs (no nullifier/secret exposed via this path).
 */
export async function encryptNoteWithViewingKey(
  note: StoredNote,
  viewingKey: CryptoKey
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Only include non-sensitive fields for the auditor — amounts and commitments only
  const auditorPayload = JSON.stringify({
    nullifierHash: note.nullifierHash,
    commitment: note.commitment,
    amount: note.amount,
    depositedAt: note.depositedAt,
    spent: note.spent,
  });
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    viewingKey,
    new TextEncoder().encode(auditorPayload)
  );
  return {
    iv: Buffer.from(iv).toString("hex"),
    ct: Buffer.from(ct).toString("hex"),
  };
}

/**
 * Decrypt notes using the viewing key (auditor read path).
 * Returns partial note records — amounts and commitments, no spending keys.
 */
export async function loadNotesWithViewingKey(
  address: string,
  viewingKey: CryptoKey
): Promise<Array<{ nullifierHash: string; commitment: string; amount: string; depositedAt: number; spent: boolean }>> {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY(address));
    if (!raw) return [];
    const records = JSON.parse(raw) as NoteRecord[];
    const result = [];
    for (const r of records) {
      // Only records that have a viewingCipher can be read by the auditor
      const stored = r as StoredNote;
      if (!stored.viewingCipher) continue;
      try {
        const iv = Buffer.from(stored.viewingCipher.iv, "hex");
        const ct = Buffer.from(stored.viewingCipher.ct, "hex");
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, viewingKey, ct);
        result.push(JSON.parse(new TextDecoder().decode(plain)));
      } catch {
        // Wrong key or corrupted — skip
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** Short display label for a note */
export function noteLabel(note: StoredNote): string {
  if (note.label) return note.label;
  const eth = (BigInt(note.amount) * 10000n / BigInt(1e18));
  const ethDisplay = (Number(eth) / 10000).toFixed(4);
  const d = new Date(note.depositedAt);
  const date = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const short = note.commitment.slice(-4);
  return `${ethDisplay} ETH · ${date} ${time} · #${short}`;
}
