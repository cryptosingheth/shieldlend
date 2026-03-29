/**
 * ShieldLend Circuit Interface
 * ============================
 * Handles ZK proof generation in the browser using snarkjs WASM.
 *
 * All proving happens CLIENT-SIDE — the user's private inputs (nullifier, secret)
 * never leave their browser. This is the core trust model of ShieldLend.
 *
 * Revision note — How browser-side proving works:
 *   1. Circom compiles circuits to .wasm (WebAssembly) + .zkey (proving key)
 *   2. snarkjs can run in the browser via the WASM build
 *   3. The user's nullifier and secret stay in browser memory only
 *   4. The resulting Groth16 proof is ~200 bytes and contains NO private data
 *   5. The proof is submitted to zkVerify, then the attestation goes on-chain
 */

import { buildPoseidon } from "circomlibjs";

// Field size for BabyJubJub (Poseidon's native field)
const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

// Paths to WASM and zkey files (served from /public/circuits/)
const CIRCUIT_PATHS = {
  deposit: {
    wasm: "/circuits/deposit.wasm",
    zkey: "/circuits/deposit_final.zkey",
  },
  withdraw: {
    wasm: "/circuits/withdraw.wasm",
    zkey: "/circuits/withdraw_final.zkey",
  },
  collateral: {
    wasm: "/circuits/collateral.wasm",
    zkey: "/circuits/collateral_final.zkey",
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Note {
  nullifier: bigint;
  secret: bigint;
  amount: bigint;
  commitment: bigint;
  nullifierHash: bigint;
}

export interface DepositProof {
  proof: object;
  publicSignals: string[];
  commitment: bigint;
  nullifierHash: bigint;
}

export interface WithdrawProof {
  proof: object;
  publicSignals: string[];
}

export interface CollateralProof {
  proof: object;
  publicSignals: string[];
}

export interface MerklePath {
  pathElements: bigint[];
  pathIndices: number[];
  root: bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cryptographic helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random field element.
 * Used to generate nullifier and secret for each deposit note.
 */
export function randomFieldElement(): bigint {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  let value = 0n;
  for (const byte of arr) {
    value = (value << 8n) | BigInt(byte);
  }
  return value % FIELD_SIZE;
}

/**
 * Compute commitment and nullifierHash for a deposit.
 * commitment    = Poseidon(nullifier, secret, amount)
 * nullifierHash = Poseidon(nullifier)
 */
export async function computeCommitment(
  nullifier: bigint,
  secret: bigint,
  amount: bigint
): Promise<{ commitment: bigint; nullifierHash: bigint }> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const commitment = F.toObject(poseidon([nullifier, secret, amount])) as bigint;
  const nullifierHash = F.toObject(poseidon([nullifier])) as bigint;

  return { commitment, nullifierHash };
}

/**
 * Create a new deposit note (nullifier + secret + commitment).
 * The note must be saved by the user — losing it means losing access to funds.
 */
export async function createNote(amount: bigint): Promise<Note> {
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const { commitment, nullifierHash } = await computeCommitment(
    nullifier,
    secret,
    amount
  );
  return { nullifier, secret, amount, commitment, nullifierHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof generation (browser-side via snarkjs WASM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a deposit proof.
 * Proves: commitment = Poseidon(nullifier, secret, amount)
 */
export async function generateDepositProof(note: Note): Promise<DepositProof> {
  // Dynamically import snarkjs to avoid SSR issues in Next.js
  const snarkjs = await import("snarkjs");

  const input = {
    nullifier: note.nullifier.toString(),
    secret: note.secret.toString(),
    amount: note.amount.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    CIRCUIT_PATHS.deposit.wasm,
    CIRCUIT_PATHS.deposit.zkey
  );

  return {
    proof,
    publicSignals,
    commitment: note.commitment,
    nullifierHash: note.nullifierHash,
  };
}

/**
 * Generate a withdrawal proof.
 * Proves: I know (nullifier, secret) such that Poseidon(nullifier, secret, amount)
 *         is a leaf in the Merkle tree with the given root.
 */
export async function generateWithdrawProof(
  note: Note,
  merklePath: MerklePath,
  recipient: string
): Promise<WithdrawProof> {
  const snarkjs = await import("snarkjs");

  const input = {
    nullifier: note.nullifier.toString(),
    secret: note.secret.toString(),
    pathElements: merklePath.pathElements.map((e) => e.toString()),
    pathIndices: merklePath.pathIndices.map((i) => i.toString()),
    root: merklePath.root.toString(),
    nullifierHash: note.nullifierHash.toString(),
    recipient: BigInt(recipient).toString(), // address as field element
    amount: note.amount.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    CIRCUIT_PATHS.withdraw.wasm,
    CIRCUIT_PATHS.withdraw.zkey
  );

  return { proof, publicSignals };
}

/**
 * Generate a collateral sufficiency proof.
 * Proves: collateral * 10000 >= ratio * borrowed (without revealing collateral)
 */
export async function generateCollateralProof(
  collateral: bigint,
  borrowed: bigint,
  ratio: bigint
): Promise<CollateralProof> {
  const snarkjs = await import("snarkjs");

  // Sanity check before generating (saves time if proof will fail)
  if (collateral * 10000n < ratio * borrowed) {
    throw new Error(
      `Insufficient collateral: need ${(ratio * borrowed) / 10000n}, have ${collateral}`
    );
  }

  const input = {
    collateral: collateral.toString(),
    borrowed: borrowed.toString(),
    ratio: ratio.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    CIRCUIT_PATHS.collateral.wasm,
    CIRCUIT_PATHS.collateral.zkey
  );

  return { proof, publicSignals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Note serialization (for localStorage)
// ─────────────────────────────────────────────────────────────────────────────

export function serializeNote(note: Note): string {
  return JSON.stringify({
    nullifier: note.nullifier.toString(16),
    secret: note.secret.toString(16),
    amount: note.amount.toString(),
    commitment: note.commitment.toString(16),
    nullifierHash: note.nullifierHash.toString(16),
  });
}

export function deserializeNote(json: string): Note {
  const obj = JSON.parse(json);
  return {
    nullifier: BigInt("0x" + obj.nullifier),
    secret: BigInt("0x" + obj.secret),
    amount: BigInt(obj.amount),
    commitment: BigInt("0x" + obj.commitment),
    nullifierHash: BigInt("0x" + obj.nullifierHash),
  };
}
