# ShieldLend V2A — ZK Circuit Design

All circuits are written in Circom 2.1.6 and compiled to WebAssembly for browser-side proof generation. The proof system is Groth16 (via snarkjs).

V1 circuits (deposit.circom, withdraw.circom, collateral.circom) have been superseded by V2A ring circuits. They remain in circuits/ for reference only.

---

## V2A Commitment Formula

All V2A circuits use a single canonical formula:

```
commitment = Poseidon(secret, nullifier)    // 2 inputs, secret first
```

This differs from V1 (Poseidon(nullifier, secret, amount)) in two ways:
1. Input order reversed — secret comes first
2. Amount removed — denominations are fixed at contract level

The same formula is used by:
- withdraw_ring.circom (commitment validity constraint)
- collateral_ring.circom (commitment validity constraint)
- circuits.ts computeCommitment() (frontend, deposit step)
- ShieldedPool.sol deposit() (stores the commitment leaf)

If these diverge even by input order, every proof fails at MerkleTreeChecker assertion.

---

## Circuit 1: withdraw_ring.circom

Purpose: Prove ring membership (prover's note is one of K=16 commitments) AND global Merkle inclusion (real commitment is in the protocol tree) WITHOUT revealing which ring member the prover owns.

### Why ring proofs?

V1 used standard Merkle membership against the full tree. Problem: with only 3 deposits, the anonymity set is trivially 3 — timing correlation attacks are straightforward.

V2A solution: prover samples K=16 commitments from the last 30 epoch flushes (mix of real deposits and protocol-inserted dummies). The proof shows the prover's note is one of the 16, but ring_index is private — the verifier cannot tell which one. With 10 dummies/epoch across 30 epochs, minimum anonymity set is 300 at protocol launch with zero real users.

### Signals

```
// Private inputs (never revealed)
signal input secret;
signal input nullifier;
signal input ring_index;              // prover's position in ring (0..K-1)
signal input pathElements[levels];   // Merkle auth path siblings
signal input pathIndices[levels];    // 0=left, 1=right per level

// Public inputs (visible on-chain)
signal input ring[K];                 // 16 commitments
signal input root;                    // current Merkle root
signal input recipient;               // destination address
signal input amount;                  // denomination in wei
signal output nullifierHash;          // Poseidon(nullifier, ring_index)

component main = WithdrawRing(24, 16);
```

### What the proof guarantees simultaneously

1. Commitment validity: C_real = Poseidon(secret, nullifier)
2. Ring membership: ring[ring_index] == C_real  (ring_index is hidden)
3. Global inclusion: C_real is a leaf in depth-24 Merkle tree with root R
4. Spend tag: nullifierHash = Poseidon(nullifier, ring_index)

### Why recipient is a public input

If recipient were not bound to the proof, anyone observing the proof in the mempool could replace the recipient and front-run the withdrawal. Making recipient a circuit constraint means the proof is only valid for the specific address.

### Proof parameters

| Parameter | Value |
|---|---|
| Merkle depth | 24 |
| Ring size K | 16 |
| Approximate constraints | ~24,000 |
| Browser proving time | ~25 seconds |
| Proof size | 192 bytes (3 Groth16 curve points) |

---

## Circuit 2: collateral_ring.circom

Purpose: Prove ownership of a note whose denomination satisfies the LTV requirement for a given borrow amount, WITHOUT revealing the denomination, specific note, or ring position.

### Signals

```
// Private inputs
signal input secret;
signal input nullifier;
signal input denomination;            // note value in wei — PRIVATE
signal input ring_index;
signal input pathElements[levels];
signal input pathIndices[levels];

// Public inputs
signal input ring[K];
signal input root;
signal input nullifierHash;           // Poseidon(nullifier, ring_index)
signal input borrowed;                // borrow amount in wei
signal input minRatioBps;             // e.g. 11000 = 110% LTV floor

// Commitment formula: Poseidon(secret, nullifier)
// denomination is a SEPARATE private LTV witness, not in the hash

component main = CollateralRing(24, 16);
```

### What the proof guarantees

1. Commitment validity: C_real = Poseidon(secret, nullifier)
2. Ring membership: ring[ring_index] == C_real
3. Global inclusion: C_real is in Merkle tree (the deposit actually happened)
4. LTV check: denomination x 10000 >= borrowed x minRatioBps
5. Spend tag: nullifierHash = Poseidon(nullifier, ring_index)

### Why denomination is private

If denomination were public, an observer could narrow which ring member the prover owns by correlating known denomination values of ring members. Keeping it private hides collateral size while still proving the LTV inequality.

### Why denomination is NOT in the commitment hash

Both circuits use Poseidon(secret, nullifier) for commitment. This means the same deposited leaf works for both withdraw and borrow proofs — no separate commitment type needed. Denomination is a private LTV witness only. (Note: this is a production design consideration — a denomination-binding deposit circuit would be more rigorous but requires a different commitment format.)

---

## Trusted Setup (V2A)

Groth16 requires a per-circuit trusted setup. V2A uses powersOfTau28_hez_final_17.ptau.

```bash
# 1. Download ptau (iden3 GCS — Hermez S3 bucket is decommissioned)
curl -sL https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau \
     -o circuits/build/pot17.ptau

# 2. Compile circuits
circom circuits/withdraw_ring.circom --r1cs --wasm --sym -o circuits/build -l node_modules
circom circuits/collateral_ring.circom --r1cs --wasm --sym -o circuits/build -l node_modules

# 3. Groth16 setup
npx snarkjs groth16 setup circuits/build/withdraw_ring.r1cs \
    circuits/build/pot17.ptau circuits/build/withdraw_ring_0000.zkey
npx snarkjs groth16 setup circuits/build/collateral_ring.r1cs \
    circuits/build/pot17.ptau circuits/build/collateral_ring_0000.zkey

# 4. Finalize (beacon for dev)
npx snarkjs zkey beacon circuits/build/withdraw_ring_0000.zkey \
    circuits/build/withdraw_ring_final.zkey <beaconHex> 10
npx snarkjs zkey beacon circuits/build/collateral_ring_0000.zkey \
    circuits/build/collateral_ring_final.zkey <beaconHex> 10

# 5. Export verification keys
npx snarkjs zkey export verificationkey circuits/build/withdraw_ring_final.zkey \
    circuits/keys/withdraw_ring_vkey.json
npx snarkjs zkey export verificationkey circuits/build/collateral_ring_final.zkey \
    circuits/keys/collateral_ring_vkey.json
```

### Deployed VK hashes (Base Sepolia)

| Circuit | VK hash |
|---|---|
| withdraw_ring | 0x3c7529ffc44c852ad3b1b566a976ea29f379eec2a2edadb7ade311a432962e49 |
| collateral_ring | Recompiled in session 2 (commitment formula fix) — check circuits/keys/ |

The withdraw_ring VK hash is embedded in ShieldedPool.sol for attestation verification. Changing the circuit requires a new trusted setup AND a contract redeployment.

---

## circomlib Templates Used (V2A)

| Template | Used In |
|---|---|
| Poseidon(2) | Both circuits — commitment hash |
| Poseidon(2) | Both circuits — nullifierHash = Poseidon(nullifier, ring_index) |
| MerkleTreeChecker(24) | Both circuits — global Merkle inclusion |
| MultiMux1 | MerkleTreeChecker — left/right sibling ordering |
| GreaterEqThan(96) | collateral_ring — LTV inequality check |
| Num2Bits | GreaterEqThan internal bit decomposition |

---

## V1 Circuits (Superseded)

| Circuit | Issue |
|---|---|
| deposit.circom | Pedersen commitment, wrong formula for V2A |
| withdraw.circom | Depth-20 tree, single-note proof, wrong public signals |
| collateral.circom | Raw LTV check only — no proof that collateral actually exists on-chain |
