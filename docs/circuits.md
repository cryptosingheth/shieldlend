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

    ## Trusted Setup and Recompiling Circuits

Groth16 requires a per-circuit trusted setup (unlike PLONK which uses a universal setup).

### Prerequisites

- [Circom](https://docs.circom.io/getting-started/installation/) (2.x; circuits use `pragma circom 2.1.6`)
- [snarkjs](https://github.com/iden3/snarkjs) on your `PATH`
- From the **repository root**: `npm install` (circuits include `circomlib` via `../node_modules/circomlib/...`, so compilation must be run from `circuits/` after dependencies are installed)

All commands below assume your current working directory is **`circuits/`**.

### One-time: Powers of Tau

Use a Powers-of-Tau file whose size is **at least** your circuit’s constraint count (snarkjs will error if the `.ptau` is too small). `pot12_final.ptau` supports up to \(2^{12}\) constraints. If `withdraw` (or any circuit) exceeds that, download a larger Hermez final file (e.g. `powersOfTau28_hez_final_16.ptau` or higher) and point `snarkjs groth16 setup` at it instead.

```bash
mkdir -p build keys
wget https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau \
     -O keys/pot12_final.ptau
```

Keep this file and reuse it for every circuit; it is **not** circuit-specific.

### Recompiling all circuits (full pipeline)

After you change any `.circom` file, rerun **compile → setup → export** for that circuit. To refresh **everything** (artifacts + Solidity verifiers), run the following from `circuits/`.

**1. Compile each circuit** (R1CS + WASM + symbols for debugging):

```bash
circom deposit.circom    --r1cs --wasm --sym -o build/
circom withdraw.circom   --r1cs --wasm --sym -o build/
circom collateral.circom --r1cs --wasm --sym -o build/
```

**2. Groth16 setup** (one new `.zkey` per circuit — replaces previous keys for that circuit):

```bash
snarkjs groth16 setup build/deposit.r1cs    keys/pot12_final.ptau keys/deposit_0000.zkey
snarkjs groth16 setup build/withdraw.r1cs   keys/pot12_final.ptau keys/withdraw_0000.zkey
snarkjs groth16 setup build/collateral.r1cs keys/pot12_final.ptau keys/collateral_0000.zkey
```

**3. Export verification keys** (JSON, for front-end / tooling):

```bash
snarkjs zkey export verificationkey keys/deposit_0000.zkey    keys/deposit_vkey.json
snarkjs zkey export verificationkey keys/withdraw_0000.zkey   keys/withdraw_vkey.json
snarkjs zkey export verificationkey keys/collateral_0000.zkey keys/collateral_vkey.json
```

**4. Export Solidity verifiers** (into this repo’s `contracts/src/verifiers/`):

```bash
snarkjs zkey export solidityverifier keys/deposit_0000.zkey    ../contracts/src/verifiers/DepositVerifier.sol
snarkjs zkey export solidityverifier keys/withdraw_0000.zkey   ../contracts/src/verifiers/WithdrawVerifier.sol
snarkjs zkey export solidityverifier keys/collateral_0000.zkey ../contracts/src/verifiers/CollateralVerifier.sol
```

**Outputs**

| Stage | Location |
|--------|-----------|
| R1CS, WASM, `.sym` | `circuits/build/` |
| Proving keys | `circuits/keys/<name>_0000.zkey` |
| Verification key JSON | `circuits/keys/<name>_vkey.json` |
| On-chain verifier contracts | `contracts/src/verifiers/*Verifier.sol` |

**After regenerating verifiers**, redeploy those contracts (or upgrade your deployment) so on-chain bytecode matches the new verification keys. Old proofs or addresses from a previous setup will not match new `.zkey` / verifier bytecode.

### Single-circuit refresh

If only one circuit changed, run the `circom`, `snarkjs groth16 setup`, `export verificationkey`, and `export solidityverifier` lines for that circuit only.

**Note on toxic waste**: In the `groth16 setup` command, if you use `snarkjs zkey contribute` to add randomness, the randomness used is "toxic waste" — if it leaks, the proof system is compromised. For the testnet MVP, a single-party setup is used. For production, a multi-party ceremony with public participants would be required.

### Proof verification, test artifacts, and Foundry

See **[verification.md](./verification.md)** for:

- How **Groth16 `verifyProof`** works on-chain (public inputs, pairing, precompiles).
- How **zkVerify aggregation** relates to `ShieldedPool` (statement leaf vs Solidity verifiers).
- **`scripts/gen_test_proofs.js`**: regenerating `circuits/build/test_proofs.json` and Solidity calldata.
- **`contracts/test/Groth16Verifiers.t.sol`**: running real verifier tests with `forge test`.
- A full **compile → zkey → export verifier → generate proofs** checklist when circuits change.

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
