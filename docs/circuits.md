# ShieldLend V2B — ZK Circuit Design

Both circuits are written in Circom 2.1.6 and compiled to WebAssembly for in-browser proof generation. The proof system is Groth16 (snarkjs) on BN254.

The V1 circuits (`deposit.circom`, `withdraw.circom`, `collateral.circom`) were removed from the tree. They are in git history at `16cbd63`.

---

## Commitment and Spend Tag

```
commitment    = Poseidon(secret, nullifier, denomination)   // 3 inputs, this order
nullifierHash = Poseidon(nullifier)                          // 1 input
```

The commitment binds the note's value, so a prover cannot claim a larger denomination than they deposited.

The spend tag depends on the nullifier alone. An earlier version used `Poseidon(nullifier, ring_index)`, which let the same note produce a different tag in every ring it appeared in, so it could be spent twice (audit finding H-3). A spend tag must be a fixed function of the note.

The same formulas are used by:
- `withdraw_ring.circom` and `collateral_ring.circom`
- `frontend/src/lib/circuits.ts` `computeCommitment()` (deposit step)
- `ShieldedPool.sol` (stores the commitment as a Merkle leaf)

If any of these diverge, even in input order, every proof fails the Merkle inclusion check.

Accepted denominations: 0.001, 0.005, 0.01, 0.05, 0.1 and 0.5 ETH.

---

## Circuit 1: withdraw_ring.circom

Purpose: prove that the prover's note is one of K=16 public commitments (ring membership) AND is a leaf in the protocol's Merkle tree (global inclusion), without revealing which ring member it is.

### Why ring proofs?

V1 used a plain Merkle membership proof. With only a handful of deposits the anonymity set was trivially small and timing correlation was easy.

V2 samples K=16 commitments from the last 30 epoch flushes, a mix of real deposits and protocol-inserted dummies. `ring_index` is private, so the verifier cannot tell which one belongs to the prover.

### Signals

```
// Private
signal input secret;
signal input nullifier;
signal input denomination;
signal input pathElements[24];
signal input pathIndices[24];
signal input ring_index;              // 0..15, range-checked with LessThan(4)

// Public
signal input ring[16];
signal input nullifierHash;
signal input root;
signal output denomination_out;       // becomes `amount` in the attestation leaf

component main {public [ring, nullifierHash, root]} = WithdrawRing(24, 16);
```

snarkjs orders public outputs before public inputs, so the public signal vector is `[denomination_out, ring[0..15], nullifierHash, root]` (19 values).

### What the proof guarantees

1. Commitment validity: `C_real = Poseidon(secret, nullifier, denomination)`
2. Ring membership: `ring[ring_index] == C_real`, with `ring_index < 16`
3. Global inclusion: `C_real` is a leaf in the depth-24 Merkle tree with root `root`
4. Spend tag: `nullifierHash == Poseidon(nullifier)`
5. Amount: `denomination_out == denomination`

### How the recipient is bound (current limitation)

`recipient` is **not** a circuit signal. After zkVerify accepts the proof, the server's operator posts an aggregation leaf `statementHash(root, nullifierHash, recipient, denomination)`, and `ShieldedPool._verifyAttestation` checks that leaf. The recipient is therefore bound by the operator, not by the proof. A party that copies a proof before the user's withdrawal lands could ask for a leaf with a different recipient.

Planned fix: add `recipient` as a public input with a dummy constraint (`recipientSquare <== recipient * recipient`) so the proof itself fixes the payout address, then rebuild the keys and redeploy.

### Proof parameters

| Parameter | Value |
|---|---|
| Merkle depth | 24 |
| Ring size K | 16 |
| Constraints | 13,588 |
| Public signals | 19 (18 inputs + 1 output) |
| Proof size | 3 Groth16 curve points |

---

## Circuit 2: collateral_ring.circom

Purpose: prove ownership of a note large enough to back a given loan, without revealing the note, its ring position or its denomination.

### Signals

```
// Private
signal input secret;
signal input nullifier;
signal input pathElements[24];
signal input pathIndices[24];
signal input ring_index;
signal input denomination;

// Public
signal input ring[16];
signal input nullifierHash;
signal input root;
signal input borrowed;                // loan amount in wei
signal input minRatioBps;             // e.g. 5000 = loan may be at most 50% of collateral

component main {public [ring, nullifierHash, root, borrowed, minRatioBps]} = CollateralRing(24, 16);
```

### What the proof guarantees

1. Commitment validity: `C_real = Poseidon(secret, nullifier, denomination)`
2. Ring membership: `ring[ring_index] == C_real`
3. Global inclusion: `C_real` is in the Merkle tree, so the deposit happened
4. Spend tag: `nullifierHash == Poseidon(nullifier)`, which locks the note while the loan is open
5. Collateral sufficiency: `denomination * minRatioBps >= borrowed * 10000` (`GreaterEqThan(96)`)

### Why denomination is private

If it were public, an observer could narrow the ring to members with that denomination. Keeping it private hides the collateral size while still proving the inequality.

### Proof parameters

| Parameter | Value |
|---|---|
| Constraints | 13,691 |
| Public signals | 20 inputs |

The borrow path does not post an on-chain aggregation leaf. The server verifies the proof on zkVerify, then the operator records the loan in `LendingPool`.

---

## Trusted Setup

Groth16 needs a per-circuit setup. The current keys come from a local development setup (Powers of Tau `powersOfTau28_hez_final_17.ptau` plus a beacon), not a public multi-party ceremony.

```bash
# 1. Download ptau
curl -sL https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau \
     -o circuits/build/pot17.ptau

# 2. Compile
circom circuits/withdraw_ring.circom   --r1cs --wasm --sym -o circuits/build -l node_modules
circom circuits/collateral_ring.circom --r1cs --wasm --sym -o circuits/build -l node_modules

# 3. Setup + dev beacon
npx snarkjs groth16 setup circuits/build/withdraw_ring.r1cs circuits/build/pot17.ptau circuits/build/withdraw_ring_0000.zkey
npx snarkjs zkey beacon circuits/build/withdraw_ring_0000.zkey circuits/keys/withdraw_ring.zkey <beaconHex> 10
# (same for collateral_ring)

# 4. Export verification keys
npx snarkjs zkey export verificationkey circuits/keys/withdraw_ring.zkey   circuits/keys/withdraw_ring_vkey.json
npx snarkjs zkey export verificationkey circuits/keys/collateral_ring.zkey circuits/keys/collateral_ring_vkey.json
```

What ships in the repo:
- `frontend/public/circuits/*.zkey` and `*.wasm`: the browser prover
- `circuits/keys/*_vkey.json`: read by the `/api/zkverify` and `/api/borrow` routes when submitting proofs to zkVerify

All of these must come from the same setup. Changing a circuit means a new setup, a new vkHash and a redeploy of every shard.

| Circuit | vkHash (zkVerify) |
|---|---|
| withdraw_ring | `0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572` |

---

## circomlib Templates Used

| Template | Use |
|---|---|
| `Poseidon(3)` | Commitment |
| `Poseidon(1)` | nullifierHash |
| `Poseidon(2)` | Merkle node hashing |
| `MerkleTreeChecker(24)` | Global inclusion (defined in each circuit) |
| `LessThan(4)` | `ring_index` range check |
| `GreaterEqThan(96)` | collateral_ring LTV inequality |
