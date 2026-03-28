# ShieldLend — ZK Circuit Design

All circuits are written in Circom and compiled to WebAssembly for browser-side proof generation. The proof system is Groth16 (via snarkjs).

---

## Why Browser-Side Proof Generation?

If proofs were generated on a server, that server would see the user's secret — destroying the privacy guarantee. By compiling circuits to WASM and running them in the browser, the user's `secret` and `nullifier` never leave their device.

The trade-off: browser-side proving takes 2–10 seconds for these circuit sizes. This is acceptable for a financial transaction.

---

## Circuit 1: `deposit.circom`

**Purpose**: Prove that a commitment was correctly computed from the user's secret and amount.

### Signals

```circom
pragma circom 2.0.0;

include "circomlib/circuits/pedersen.circom";
include "circomlib/circuits/poseidon.circom";

template Deposit() {
    // Private inputs (never revealed on-chain)
    signal input amount;
    signal input secret;
    signal input nullifier;

    // Public outputs (go on-chain)
    signal output commitment;
    signal output nullifierHash;

    // Commitment: Pedersen hash of (amount, secret)
    component pedersen = Pedersen(2);
    pedersen.in[0] <== amount;
    pedersen.in[1] <== secret;
    commitment <== pedersen.out[0];

    // Nullifier hash: Poseidon hash of nullifier
    component poseidon = Poseidon(1);
    poseidon.inputs[0] <== nullifier;
    nullifierHash <== poseidon.out;
}

component main {public []} = Deposit();
```

### What the proof guarantees
- The prover knows `amount` and `secret` such that `Pedersen(amount, secret) = commitment`
- The prover knows `nullifier` such that `Poseidon(nullifier) = nullifierHash`
- Neither `amount`, `secret`, nor `nullifier` is revealed

### Note format
After a successful deposit, the user receives a **note**:
```json
{
  "amount": "1000000000000000000",
  "secret": "0x...",
  "nullifier": "0x...",
  "commitment": "0x...",
  "nullifierHash": "0x...",
  "leafIndex": 42
}
```
This note is the only way to withdraw. It must be stored securely.

---

## Circuit 2: `withdraw.circom`

**Purpose**: Prove Merkle membership (the commitment is in the pool) and nullifier knowledge (the prover owns the note), without revealing which note or how much.

### Signals

```circom
pragma circom 2.0.0;

include "circomlib/circuits/pedersen.circom";
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/merkleProof.circom";  // MerkleTreeChecker

template Withdraw(levels) {
    // Private inputs (never revealed)
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];   // Merkle proof siblings
    signal input pathIndices[levels];    // 0 = left, 1 = right at each level

    // Public inputs (go on-chain, visible to verifier)
    signal input root;           // current Merkle root in ShieldedPool.sol
    signal input recipient;      // where to send the withdrawn funds

    // Public output
    signal output nullifierHash;

    // Step 1: Recompute the commitment from secret
    // (amount is not needed — we're proving we know the note, not the amount)
    component pedersen = Pedersen(1);
    pedersen.in[0] <== secret;
    signal commitment <== pedersen.out[0];

    // Step 2: Verify commitment is in the Merkle tree
    component merkleChecker = MerkleTreeChecker(levels);
    merkleChecker.leaf <== commitment;
    merkleChecker.root <== root;
    for (var i = 0; i < levels; i++) {
        merkleChecker.pathElements[i] <== pathElements[i];
        merkleChecker.pathIndices[i] <== pathIndices[i];
    }

    // Step 3: Compute nullifier hash
    component poseidon = Poseidon(1);
    poseidon.inputs[0] <== nullifier;
    nullifierHash <== poseidon.out;

    // Step 4: Bind recipient to proof (prevents front-running)
    signal recipientSquared;
    recipientSquared <== recipient * recipient;
}

component main {public [root, recipient]} = Withdraw(20);
```

### What the proof guarantees
- The commitment `Pedersen(secret)` is a leaf in the Merkle tree with root `root`
- The prover knows the `secret` behind that commitment
- The `nullifierHash` is correctly derived from `nullifier`
- The proof is bound to `recipient` — cannot be front-run to redirect funds

### Why `recipient` is a public input
Without binding `recipient` to the proof, anyone who observes the proof in the mempool could replace the recipient address and submit their own transaction before the original. Making `recipient` a circuit input prevents this — the proof is only valid for the specific recipient.

---

## Circuit 3: `collateral.circom`

**Purpose**: Prove that a user's collateral meets the minimum collateral ratio for borrowing, without revealing the exact collateral amount.

### Signals

```circom
pragma circom 2.0.0;

include "circomlib/circuits/comparators.circom";

template CollateralCheck() {
    // Private input: the exact collateral amount (hidden)
    signal input exact_collateral;

    // Public inputs: visible to the contract
    signal input min_ratio;       // e.g., 150 means 150% collateralization required
    signal input borrowed_amount; // how much the user wants to borrow

    // Constraint: exact_collateral * 100 >= min_ratio * borrowed_amount
    signal lhs;
    signal rhs;
    lhs <== exact_collateral * 100;
    rhs <== min_ratio * borrowed_amount;

    component gte = GreaterEqThan(64);
    gte.in[0] <== lhs;
    gte.in[1] <== rhs;
    gte.out === 1;
}

component main {public [min_ratio, borrowed_amount]} = CollateralCheck();
```

### What the proof guarantees
- `exact_collateral * 100 >= min_ratio * borrowed_amount`
- The `exact_collateral` value is never revealed — only the boolean fact that it meets the ratio

### Example
If `min_ratio = 150` (150% collateralization) and `borrowed_amount = 1000 USDC`:
- Required: `exact_collateral >= 1500 USDC`
- The proof proves this without revealing that collateral is, say, 2000 USDC

---

## Trusted Setup

Groth16 requires a per-circuit trusted setup (unlike PLONK which uses a universal setup).

```bash
# Step 1: Download an existing Powers of Tau file (Hermez ceremony)
# pot12_final.ptau supports circuits up to 2^12 = 4096 constraints
wget https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau \
     -O pot12_final.ptau

# Step 2: Per-circuit setup
circom deposit.circom --r1cs --wasm --sym -o build/
snarkjs groth16 setup build/deposit.r1cs pot12_final.ptau keys/deposit_0000.zkey

# Step 3: Export verification key
snarkjs zkey export verificationkey keys/deposit_0000.zkey keys/deposit_vkey.json

# Step 4: Export Solidity verifier
snarkjs zkey export solidityverifier keys/deposit_0000.zkey contracts/src/DepositVerifier.sol

# Repeat for withdraw.circom and collateral.circom
```

**Note on toxic waste**: In the `groth16 setup` command, if you use `snarkjs zkey contribute` to add randomness, the randomness used is "toxic waste" — if it leaks, the proof system is compromised. For the testnet MVP, a single-party setup is used. For production, a multi-party ceremony with public participants would be required.

---

## Constraint Counts (Estimated)

| Circuit | Constraints | Proving time (browser) |
|---------|------------|----------------------|
| `deposit.circom` | ~1,000 | ~1–2 seconds |
| `withdraw.circom` (20 levels) | ~25,000 | ~5–8 seconds |
| `collateral.circom` | ~200 | <1 second |

These estimates assume a standard laptop. Mobile browsers may be 3–5x slower.

---

## circomlib Templates Used

| Template | Library | Used In |
|----------|---------|---------|
| `Pedersen` | circomlib/circuits/pedersen.circom | deposit.circom, withdraw.circom |
| `Poseidon` | circomlib/circuits/poseidon.circom | deposit.circom, withdraw.circom |
| `MerkleTreeChecker` | circomlib/circuits/merkleProof.circom | withdraw.circom |
| `GreaterEqThan` | circomlib/circuits/comparators.circom | collateral.circom |
