/**
 * ShieldLend Note Storage
 * ========================
 * Stores deposit notes in browser localStorage, keyed by nullifierHash.
 *
 * Security model: localStorage is NOT encrypted. Notes are stored in plaintext.
 * This is acceptable for a testnet demo — in production you would derive a
 * symmetric key from the user's signature (e.g. MetaMask personal_sign) and
 * encrypt notes with AES-GCM before storing.
 *
 * Key structure: `shieldlend_notes_<address>` → JSON array of StoredNote
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
}

const STORAGE_KEY = (address: string) =>
  `shieldlend_notes_${address.toLowerCase()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Read / Write
// ─────────────────────────────────────────────────────────────────────────────

export function loadNotes(address: string): StoredNote[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY(address));
    return raw ? (JSON.parse(raw) as StoredNote[]) : [];
  } catch {
    return [];
  }
}

export function saveNote(address: string, note: Note, depositTx?: string): StoredNote {
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

  const existing = loadNotes(address);
  // Deduplicate by nullifierHash
  const without = existing.filter((n) => n.nullifierHash !== stored.nullifierHash);
  localStorage.setItem(STORAGE_KEY(address), JSON.stringify([stored, ...without]));
  return stored;
}

export function markNoteSpent(address: string, nullifierHash: string): void {
  const notes = loadNotes(address).map((n) =>
    n.nullifierHash.toLowerCase() === nullifierHash.toLowerCase()
      ? { ...n, spent: true }
      : n
  );
  localStorage.setItem(STORAGE_KEY(address), JSON.stringify(notes));
}

export function deleteNote(address: string, nullifierHash: string): void {
  const notes = loadNotes(address).filter(
    (n) => n.nullifierHash.toLowerCase() !== nullifierHash.toLowerCase()
  );
  localStorage.setItem(STORAGE_KEY(address), JSON.stringify(notes));
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

/** Short display label for a note */
export function noteLabel(note: StoredNote): string {
  if (note.label) return note.label;
  const eth = (BigInt(note.amount) * 10000n / BigInt(1e18)) ;
  const ethDisplay = (Number(eth) / 10000).toFixed(4);
  const ts = new Date(note.depositedAt).toLocaleDateString();
  return `${ethDisplay} ETH · ${ts}`;
}
