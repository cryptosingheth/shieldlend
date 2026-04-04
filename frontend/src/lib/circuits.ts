/**
 * ShieldLend V2 Circuit Interface
 * ================================
 * Handles ZK proof generation in the browser using snarkjs WASM.
 *
 * V2 changes from V1:
 *   - withdraw_ring.circom (LEVELS=24, K=16 ring)
 *   - commitment    = Poseidon(secret, nullifier)         [2 inputs]
 *   - nullifierHash = Poseidon(nullifier, ring_index)     [ring-index dependent]
 *   - Ring inputs: ring[16], ring_index required for withdrawal proof
 *   - No separate deposit circuit — commitment computed client-side
 *
 * All proving happens CLIENT-SIDE — nullifier and secret never leave the browser.
 */

import { buildPoseidon } from "circomlibjs";

// BN128 / BabyJubJub field size (Poseidon's native field)
const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

// V2 circuit files (served from /public/circuits/)
const CIRCUIT_PATHS = {
  withdraw: {
    wasm: "/circuits/withdraw_ring.wasm",
    zkey: "/circuits/withdraw_ring.zkey",
  },
} as const;

// Ring size — must match K param in withdraw_ring.circom
const RING_SIZE = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Note {
  nullifier: bigint;
  secret: bigint;
  amount: bigint;        // wei
  commitment: bigint;    // Poseidon(secret, nullifier)
  nullifierHash: bigint; // Poseidon(nullifier, 0) — ring_index=0 default
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
  pathElements: bigint[]; // length = LEVELS = 24
  pathIndices: number[];  // length = LEVELS = 24
  root: bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cryptographic helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a cryptographically random field element. */
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
 * Compute V2 commitment and nullifierHash.
 *
 * commitment    = Poseidon(secret, nullifier)     — matches withdraw_ring.circom
 * nullifierHash = Poseidon(nullifier, ring_index) — ring_index=0 for single-note proofs
 *
 * ring_index is baked into nullifierHash because the circuit emits it as a
 * public signal that gets registered on-chain as the spend tag.
 */
export async function computeCommitment(
  nullifier: bigint,
  secret: bigint,
  ringIndex: bigint = 0n
): Promise<{ commitment: bigint; nullifierHash: bigint }> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const commitment    = F.toObject(poseidon([secret, nullifier])) as bigint;
  const nullifierHash = F.toObject(poseidon([nullifier, ringIndex])) as bigint;

  return { commitment, nullifierHash };
}

/**
 * Create a new deposit note (nullifier + secret + commitment).
 * The note must be saved — losing it means losing access to funds.
 */
export async function createNote(amount: bigint): Promise<Note> {
  const nullifier = randomFieldElement();
  const secret    = randomFieldElement();
  const { commitment, nullifierHash } = await computeCommitment(nullifier, secret, 0n);
  return { nullifier, secret, amount, commitment, nullifierHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the ring input array for the withdraw circuit.
 *
 * Production: ring should be populated with real commitments from the same
 * epoch flush (fetched from LeafInserted events), and ring_index is the
 * prover's actual position in that shuffled ring.
 *
 * Testing / single-note: ring[0] = prover's commitment, ring[1..15] = distinct
 * non-zero dummy values. Anonymity set = 1.
 */
function buildRing(commitment: bigint): { ring: bigint[]; ringIndex: number } {
  const ring: bigint[] = [commitment];
  for (let i = 1; i < RING_SIZE; i++) {
    ring.push(BigInt(i + 1));
  }
  return { ring, ringIndex: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof generation (browser-side via snarkjs WASM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a V2 withdrawal proof via withdraw_ring.circom.
 *
 * Private: secret, nullifier, ring_index, pathElements, pathIndices
 * Public:  ring[16], root, nullifierHash
 *
 * Note: recipient is accepted as a parameter for future use (e.g. passing to
 * the contract call) but is NOT a circuit signal — withdraw_ring.circom has no
 * recipient/relayer/fee inputs.
 */
export async function generateWithdrawProof(
  note: Note,
  merklePath: MerklePath,
  recipient: string
): Promise<WithdrawProof> {
  if (merklePath.pathElements.length !== 24) {
    throw new Error(
      `pathElements must have 24 elements (got ${merklePath.pathElements.length}). ` +
      `Ensure LEVELS=24 in withdraw_ring.circom.`
    );
  }

  const snarkjs = await import("snarkjs");
  const { ring, ringIndex } = buildRing(note.commitment);

  const input = {
    // Private inputs
    secret:       note.secret.toString(),
    nullifier:    note.nullifier.toString(),
    ring_index:   ringIndex.toString(),
    pathElements: merklePath.pathElements.map((e) => e.toString()),
    pathIndices:  merklePath.pathIndices.map((i) => i.toString()),

    // Public inputs
    ring:         ring.map((r) => r.toString()),
    root:         merklePath.root.toString(),
    nullifierHash: note.nullifierHash.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    CIRCUIT_PATHS.withdraw.wasm,
    CIRCUIT_PATHS.withdraw.zkey
  );

  return { proof, publicSignals };
}

/**
 * Generate a V2 collateral proof via collateral_ring.circom.
 * Requires collateral_ring.wasm + collateral_ring.zkey in /public/circuits/.
 *
 * Private: secret, nullifier, denomination, ring_index, pathElements[24], pathIndices[24]
 * Public:  ring[16], nullifierHash, root, borrowed, minRatioBps
 *
 * Commitment formula matches withdraw_ring: Poseidon(secret, nullifier) — no denomination.
 * denomination is a private witness used only for the LTV inequality check.
 * This ensures the same on-chain leaf works for both withdraw and borrow proofs.
 */
export async function generateCollateralProof(
  note: Note,
  merklePath: MerklePath,
  borrowed: bigint,
  minRatioBps: bigint
): Promise<CollateralProof> {
  if (merklePath.pathElements.length !== 24) {
    throw new Error(
      `pathElements must have 24 elements (got ${merklePath.pathElements.length}). ` +
      `Ensure LEVELS=24 in collateral_ring.circom.`
    );
  }

  const snarkjs = await import("snarkjs");
  const { ring, ringIndex } = buildRing(note.commitment);

  const input = {
    // Private inputs
    secret:       note.secret.toString(),
    nullifier:    note.nullifier.toString(),
    denomination: note.amount.toString(),   // private — LTV check only, not in commitment hash
    ring_index:   ringIndex.toString(),
    pathElements: merklePath.pathElements.map((e) => e.toString()),
    pathIndices:  merklePath.pathIndices.map((i) => i.toString()),

    // Public inputs
    ring:          ring.map((r) => r.toString()),
    nullifierHash: note.nullifierHash.toString(),
    root:          merklePath.root.toString(),
    borrowed:      borrowed.toString(),
    minRatioBps:   minRatioBps.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    "/circuits/collateral_ring.wasm",
    "/circuits/collateral_ring.zkey"
  );

  return { proof, publicSignals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Note serialization (for localStorage / vault)
// ─────────────────────────────────────────────────────────────────────────────

export function serializeNote(note: Note): string {
  return JSON.stringify({
    nullifier:    note.nullifier.toString(16),
    secret:       note.secret.toString(16),
    amount:       note.amount.toString(),
    commitment:   note.commitment.toString(16),
    nullifierHash: note.nullifierHash.toString(16),
  });
}

export function deserializeNote(json: string): Note {
  const obj = JSON.parse(json);
  return {
    nullifier:    BigInt("0x" + obj.nullifier),
    secret:       BigInt("0x" + obj.secret),
    amount:       BigInt(obj.amount),
    commitment:   BigInt("0x" + obj.commitment),
    nullifierHash: BigInt("0x" + obj.nullifierHash),
  };
}
