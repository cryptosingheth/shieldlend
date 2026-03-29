# ShieldLend — Technical Deep Dive
**For ZK Cohort Presentation + Instructor Review**

---

## The Core Idea in One Sentence

ShieldLend proves you own a deposit — without revealing which deposit is yours — using Zero-Knowledge Proofs, Poseidon hashing, and an incremental Merkle tree.

---

## Architecture Overview

```
User's Browser
  │
  ├── generateNote()         → Poseidon(nullifier, secret, amount) = commitment
  ├── generateWithdrawProof() → Groth16 proof (snarkjs WASM, runs locally)
  │
  └── API Route /api/zkverify
        └── zkVerifySession   → submits proof to Volta testnet
              └── attestation → returned to browser
                    └── withdraw() on-chain → ShieldedPool.sol
                          └── transfers ETH to recipient
```

---

## Part 1: The ZK Circuits

### Why Circom?

Circom is a domain-specific language for writing **arithmetic circuits** — mathematical constraints that define what a valid proof looks like. You write the rules ("the prover must know X such that Y"), and the Groth16 prover generates a proof that satisfies those rules.

### Circuit 1: `deposit.circom` (~540 constraints)

**What it proves:** "I know a nullifier, secret, and amount such that Poseidon(nullifier, secret, amount) = commitment"

**Why it matters:** The commitment goes on-chain. The nullifier and secret stay private. No one can reverse-engineer them from the commitment (Poseidon is a one-way function).

```
Private inputs:  nullifier, secret, amount
Public output:   commitment = Poseidon(nullifier, secret, amount)
```

In practice, the deposit circuit is not used for on-chain verification — the commitment is just computed in JavaScript. But having it as a circuit proves the commitment was formed correctly.

### Circuit 2: `withdraw.circom` (~6,020 constraints)

**What it proves:**
1. "I know a note (nullifier, secret, amount) whose commitment is in the Merkle tree" (membership proof)
2. "The nullifierHash = Poseidon(nullifier) is unique to this note" (double-spend prevention)

```
Private inputs:  nullifier, secret, amount
                 pathElements[20], pathIndices[20]  ← Merkle path
Public inputs:   root (current Merkle root)
                 nullifierHash = Poseidon(nullifier)
                 recipient, amount
```

The 20-level Merkle tree supports 2^20 = 1,048,576 deposits. The path is 20 sibling hashes — enough to reconstruct the root.

**Key insight:** The nullifier is private, but nullifierHash is public. The contract records nullifierHash as spent, preventing double withdrawal. An observer sees "this nullifierHash was spent" but cannot link it to any specific deposit.

### Circuit 3: `collateral.circom` (~42 constraints)

**What it proves:** "I have collateral ≥ 150% of borrowed amount, without revealing the collateral amount"

```
Private input:   collateral
Public inputs:   borrowed, ratio (e.g. 15000 for 150%)
Constraint:      collateral * 10000 ≥ ratio * borrowed
```

Uses `GreaterEqThan(n)` from circomlib — a range proof gadget that compares two numbers using bit decomposition.

---

## Part 2: The Trusted Setup

### What is Powers of Tau?

Groth16 requires a **trusted setup ceremony** — a one-time computation that generates public parameters (called `ptau`). These parameters encode a secret toxic waste value τ (tau). If τ is ever revealed, fake proofs can be generated.

The Hermez network ran a multi-party ceremony with thousands of participants. As long as at least one participant deleted their τ, the setup is safe. We use their `pot14_final.ptau` (power=14, supports up to 2^14 = 16,384 constraints per circuit).

### Per-circuit setup

After the ptau ceremony, each circuit gets its own proving/verification keys:

```bash
# Phase 2 (per-circuit)
snarkjs groth16 setup withdraw.r1cs pot14_final.ptau withdraw_0000.zkey
snarkjs zkey contribute withdraw_0000.zkey withdraw_final.zkey
snarkjs zkey export verificationkey withdraw_final.zkey withdraw_vkey.json
```

The `withdraw_final.zkey` is the **proving key** (5MB, used by the prover).
The `withdraw_vkey.json` is the **verification key** (3KB, embedded in the verifier contract).

---

## Part 3: The Smart Contracts

### `ShieldedPool.sol` — The core privacy primitive

Implements an **incremental Merkle tree** — a data structure that allows O(log N) insertion without rebuilding the entire tree.

```
deposit(bytes32 commitment) external payable
  → inserts commitment into Merkle tree
  → emits Deposit(commitment, leafIndex, timestamp, amount)

withdraw(proof, root, nullifierHash, recipient, amount, attestationId) external
  → checks root is recent (last 30 roots stored)
  → checks nullifierHash not spent
  → verifies zkVerify attestation
  → marks nullifier spent
  → transfers ETH to recipient
```

**Critical design choice:** `hashLeftRight()` uses **Poseidon** (not keccak256). This is essential — the circuit uses Poseidon for tree hashing, and the contract must produce identical roots. If they diverge, every proof fails.

```solidity
function hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
    return bytes32(PoseidonT3.hash([uint256(left), uint256(right)]));
}
```

### `NullifierRegistry.sol` — Double-spend prevention

Stores a mapping of spent nullifier hashes. When a withdrawal is submitted, the nullifier hash is permanently marked spent. Attempting to withdraw twice produces a `NullifierAlreadySpent` revert.

**Circular dependency solution:** ShieldedPool needs NullifierRegistry's address, and NullifierRegistry needs ShieldedPool's address. Solved with a one-time `setShieldedPool()` admin initializer called after deployment.

### `LendingPool.sol` — ZK-collateral lending

Accepts a Groth16 collateral proof (verifying the borrower has ≥150% collateral) and disburses ETH. Interest accrues over time. `repay()` accepts ETH and marks the loan closed.

### Verifier Contracts (`*Verifier.sol`)

Auto-generated by snarkjs from the verification key. Each verifier is ~250 lines of assembly-heavy Solidity that performs Groth16 pairing checks using the BN128 elliptic curve.

```solidity
function verifyProof(
    uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC,
    uint[N] calldata _pubSignals
) public view returns (bool)
```

A valid Groth16 proof is ~200 bytes. Verification costs ~250,000 gas on-chain.

---

## Part 4: zkVerify Integration

### What zkVerify does

zkVerify is a dedicated proof verification blockchain (Volta testnet). Instead of verifying proofs directly on Ethereum/Base (expensive — ~250k gas per proof), you:

1. Submit proof to zkVerify Volta → costs ~$0.001 on Volta
2. zkVerify verifies and produces an **attestation** (an on-chain statement that "proof X was valid")
3. The attestation aggregates into a Merkle tree of verified proofs
4. On Base Sepolia, `ShieldedPool` checks the attestation ID

For the demo, `_verifyAttestation()` in ShieldedPool is a stub (returns true). A production implementation would bridge the Volta attestation to Base using zkVerify's cross-chain messaging.

### Why this matters for the hackathon

zkVerify enables **proof aggregation** — thousands of proofs can be verified for the cost of one. This is the key to making ZK-based DeFi economically viable. Without aggregation, each withdrawal costs ~250k gas for proof verification alone (~$5 at moderate gas prices).

---

## Part 5: The Frontend — How Proofs are Generated in the Browser

### Note creation (Deposit tab)

```typescript
// 1. Generate random private inputs
const nullifier = generateRandomField(); // random 254-bit number
const secret = generateRandomField();
const amount = parseEther("0.005");

// 2. Compute commitment using Poseidon WASM
const poseidon = await buildPoseidon();
const commitment = F.toObject(poseidon([nullifier, secret, amount]));

// 3. Commitment goes on-chain; nullifier+secret stay in browser
```

### Merkle path reconstruction (Withdraw tab)

The browser fetches all `Deposit` events from the ShieldedPool and reconstructs the Merkle tree:

```typescript
// Sparse tree algorithm — O(20) hashes instead of O(2^20)
// Step 1: precompute zero hashes
zeros[0] = 0n;
zeros[i] = Poseidon(zeros[i-1], zeros[i-1]); // for i = 1..20

// Step 2: walk up the tree from leaf to root
// At each level, sibling = known commitment OR zeros[level]
// Compute only ~40 hashes instead of 2 million
```

### Proof generation

```typescript
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { nullifier, secret, amount, pathElements, pathIndices },
    "/circuits/withdraw.wasm",   // 2.3MB WebAssembly
    "/circuits/withdraw_final.zkey" // 5MB proving key
);
// ~5-10 seconds in a Web Worker (off main thread)
```

The proof is ~200 bytes (3 elliptic curve points). Public signals (root, nullifierHash, recipient, amount) are ~4 field elements.

---

## Part 6: Privacy Model

### What is hidden
- Which deposit corresponds to which withdrawal
- The depositor's address (if they use a different wallet for withdrawal)
- The nullifier and secret (commitment is a one-way hash)

### What is public
- Total pool size (sum of all deposits)
- Individual deposit amounts (unless you use fixed denominations like Tornado Cash)
- Withdrawal amounts
- The commitment (but not what it represents)

### Limitations of this demo
- Variable deposit amounts leak some information (amounts are public on-chain)
- Production privacy protocols use **fixed denominations** (e.g., exactly 0.1 ETH) so no amount information is revealed
- The ZK proof proves membership but not the specific leaf — this is the privacy guarantee

---

## Explaining to the Instructor / Community

### The 30-second pitch
> "ShieldLend uses Zero-Knowledge Proofs to let you deposit ETH and later withdraw it to a different address, with no on-chain link between them. The math guarantees that you can prove you made a deposit without revealing which one. We built this using Circom circuits, Groth16 proving, and zkVerify for proof aggregation."

### Key technical talking points
1. **Poseidon hash** — designed for ZK circuits, 8x fewer constraints than SHA256. Used for both commitments and Merkle tree hashing.
2. **Incremental Merkle tree** — O(log N) insertion. 20 levels = 1M deposits supported.
3. **Nullifier pattern** — `nullifierHash = Poseidon(nullifier)` is public but unlinkable to the commitment.
4. **Groth16 proofs** — 200 bytes, ~5-10 seconds to generate, ~$0.10 to verify on L2.
5. **Sparse tree optimization** — proof generation went from 60 seconds (full tree rebuild) to 5 seconds (sparse path computation).

### What makes ShieldLend different from Tornado Cash
- Lending: deposits can be used as collateral without revealing the collateral amount
- zkVerify: proof aggregation reduces verification cost by 100x vs direct on-chain verification
- Horizen L3 target: zero gas fees for users
