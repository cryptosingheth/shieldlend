# ShieldLend V2A — Technical Deep Dive

---

## The Core Idea in One Sentence

ShieldLend V2A uses ring ZK proofs, epoch batch insertion, adaptive dummy commitments, and AES-256-GCM note encryption to let you deposit ETH and later withdraw it to a different address — with no on-chain link, no timing correlation, and no dependency on how many other users are in the protocol.

---

## Architecture Overview

```
User's Browser
  |
  +-- computeCommitment()           -> Poseidon(secret, nullifier) = commitment
  +-- AES-256-GCM encrypt(note)     -> localStorage (wallet-derived key)
  +-- generateWithdrawProof()       -> Groth16 ring proof (snarkjs WASM, ~25s)
  +-- generateCollateralProof()     -> Groth16 ring proof (snarkjs WASM, ~25s)
  |
  +-- API Route /api/zkverify
        -> zkVerifySession          -> submits proof to Volta testnet
              -> { domainId, aggId } -> returned to browser
                    |
  +-- API Route /api/withdraw or /api/borrow
        -> submitAggregation()      -> aggRoot = keccak256(statementHash(...))
                                    -> ZkVerifyAggregation.submitAggregation()
                    |
              -> withdraw() on-chain -> ShieldedPool.sol
                    -> verifyProofAggregation -> transfers ETH to recipient
```

---

## Part 1: The ZK Circuits

### Why Circom?

Circom is a DSL for writing arithmetic circuits — mathematical constraints defining what a valid proof looks like. You write the rules, and the Groth16 prover generates a 192-byte proof satisfying them.

### Circuit 1: withdraw_ring.circom (~24k constraints)

This is the core privacy circuit.

What it proves:
1. I know (secret, nullifier) such that Poseidon(secret, nullifier) = C_real
2. C_real is one of the K=16 commitments in the public ring (at position ring_index, which is PRIVATE)
3. C_real is a leaf in the depth-24 global Merkle tree with root R (it was actually deposited)
4. nullifierHash = Poseidon(nullifier, ring_index) is the correct spend tag

```
Private:  secret, nullifier, ring_index, pathElements[24], pathIndices[24]
Public:   ring[16], root, recipient, amount
Output:   nullifierHash
```

Key insight: the observer sees ring[16] (16 possible notes) and nullifierHash, but cannot determine which ring member the prover owns because ring_index is private. With 10 dummies/epoch and 30 epochs in the ring selection window, the minimum anonymity set is 300 at protocol launch.

### Circuit 2: collateral_ring.circom (~24k constraints)

Same ring structure as withdraw_ring, with an additional LTV inequality check.

What it proves:
1-3. Same ring membership + Merkle inclusion proof as above
4. denomination (PRIVATE) x 10000 >= borrowed x minRatioBps
5. The note's denomination actually satisfies the LTV requirement

```
Private:  secret, nullifier, denomination, ring_index, pathElements[24], pathIndices[24]
Public:   ring[16], root, nullifierHash, borrowed, minRatioBps
```

Why denomination is private: if denomination were public, an observer could narrow which ring member the prover owns by correlating denomination values. Keeping it private hides collateral size.

Why denomination is NOT in the commitment hash: Both circuits use Poseidon(secret, nullifier). This means the same deposited leaf works for both withdraw and borrow proofs.

### What changed from V1 circuits

| Aspect | V1 | V2A |
|---|---|---|
| Circuit | withdraw.circom (single-note) | withdraw_ring.circom (K=16 ring) |
| Depth | 20 | 24 |
| Commitment | Poseidon(nullifier, secret, amount) | Poseidon(secret, nullifier) |
| nullifierHash | Poseidon(nullifier) | Poseidon(nullifier, ring_index) |
| Anonymity set | Depends on real user count | 300+ at launch (dummies) |
| Proving time | ~5-8s | ~25s |

---

## Part 2: The Epoch Batching System

This is the temporal privacy layer — it prevents timing correlation attacks.

### The Problem with Immediate Insertion

Without batching, if you deposit at block N and withdraw at block N+51, an observer sees:
- Block N: commitment C_X inserted into Merkle tree
- Block N+51: withdrawal consuming nullifierHash Y

Even with a valid ZK proof, if there was only one deposit between blocks N and N+51, the observer trivially knows which deposit corresponds to the withdrawal.

### The V2A Solution

```
deposit(C_real) -> pendingCommitments[] queue  (NOT yet in tree)

Every 50 blocks, flushEpoch() is called:
  1. Snapshot the pending queue
  2. Generate adaptive dummy commitments:
     - 0-3 real deposits this epoch  -> insert 10 dummies
     - 4-9 real deposits             -> insert 5 dummies
     - 10+ real deposits             -> insert 2 dummies
  3. Shuffle (real + dummies) using block.prevrandao
  4. _insert() each into depth-24 Merkle tree
  5. Emit LeafInserted(commitment, leafIndex) for each
```

Result: an observer cannot tell which commitments are real vs dummy, and cannot tell which position in the batch a real deposit occupies.

### Why block.prevrandao (not block.timestamp or blockhash)?

On Ethereum post-merge, `block.prevrandao` is the RANDAO beacon value — essentially unmanipulable by block proposers for a single block's shuffle. A proposer would need to grind through 2^255 RANDAO values to influence the shuffle order — economically irrational.

### The 50-block UX tradeoff

50 blocks on Base Sepolia = ~100 seconds. This is the price of temporal privacy. The frontend shows:
- Amber countdown banner: "~N blocks (~Ns) until epoch flush"
- When epoch is ready: "Ready — click Withdraw to proceed"
- On Withdraw click: auto-triggers flushEpoch() (first MetaMask tx), then immediately proceeds with the ZK proof

---

## Part 3: Note Encryption

V1 stored notes as plaintext JSON in localStorage. Anyone with access to the user's browser storage could steal all funds.

### V2A Key Derivation

```
1. User clicks "Connect Wallet" and signs the fixed message:
   "ShieldLend: Sign to derive vault key"
2. Browser receives the 65-byte ECDSA signature
3. Key = HKDF(
     ikm  = signature bytes,
     salt = keccak256("ShieldLend note key"),
     info = "note encryption key"
   )  ->  32-byte AES key (as CryptoKey object)
4. Every note is encrypted:
   ciphertext = AES-256-GCM(key, JSON.stringify(note))
   stored as { iv, ciphertext } in localStorage
```

### Properties

- Deterministic: same wallet always derives the same key -> cross-device recovery works
- Wallet-bound: only the wallet owner can sign and decrypt
- Server-blind: key derivation happens entirely client-side; key never reaches any server
- Forward-secure per-note: each note uses a random 96-bit IV

---

## Part 4: The Smart Contracts

### ShieldedPool.sol — The Core Privacy Primitive

The single ETH vault for the entire protocol. Key design decisions:

Vault-strategy separation: ShieldedPool holds all ETH. LendingPool has zero ETH custody. This limits the blast radius of any LendingPool vulnerability — it can only affect loan accounting, not directly drain ETH.

Auto-settle: when withdraw() is called for a note that has an active loan, ShieldedPool automatically calls LendingPool.settleCollateral() before releasing ETH. The user's loan is settled atomically with the withdrawal — no separate repay step needed.

Nullifier locking: when LendingPool.borrow() is called, it calls ShieldedPool.lockNullifier(noteNullifierHash). This prevents the user from withdrawing the collateral note until the loan is repaid, fixing the critical V1 solvency bug.

Hash function consistency: ShieldedPool uses PoseidonT3 for the Merkle tree hashLeftRight() function. This is essential — if the on-chain hash diverged from the circuit's Poseidon implementation, every proof would fail with a root mismatch.

### LendingPool.sol — Accounting Only

No ETH custody. All financial operations are proxied through ShieldedPool.

Interest rate: Aave v3 kinked two-slope utilization model.
```
U <= 80%: rate = R_base + (U/U_opt) x R_slope1
U > 80%:  rate = R_base + R_slope1 + ((U-0.8)/0.2) x R_slope2
Parameters: R_base=1%, R_slope1=4%, U_opt=80%, R_slope2=40%
```

Liquidation: health factor based, not time based. HF = (collateralAmount x LIQUIDATION_THRESHOLD) / totalOwed. Liquidatable when HF < 1. Bonus: 5% to liquidator.

No price oracle needed: collateral and borrowed asset are both ETH — no external price feed required.

---

## Part 5: zkVerify Integration

### What zkVerify does

zkVerify is a dedicated proof verification blockchain. Instead of verifying proofs on Ethereum/Base (expensive), you submit the proof to zkVerify Volta (cheap) and receive an attestation that the on-chain contract accepts.

### V2A Single-Leaf Aggregation Pattern

V2A uses a simplified single-leaf aggregation rather than full multi-proof batching:

```
1. proof + publicSignals -> /api/zkverify (Next.js server route)
2. zkVerifySession.verify().groth16(vkey).execute({ proof, publicSignals })
   -> { domainId, aggregationId }

3. /api/withdraw computes:
   leaf = statementHash([root, nullifierHash, uint160(recipient), amount])
   aggRoot = keccak256(abi.encode(leaf))
   ZkVerifyAggregation.submitAggregation(domainId, aggregationId, aggRoot)

4. Frontend calls:
   ShieldedPool.withdraw(..., domainId, aggregationId, merklePath=[], leafCount=1, leafIndex=0)

5. ShieldedPool._verifyAttestation():
   ZkVerifyAggregation.verifyProofAggregation(domainId, aggId, aggRoot, [], 1, 0, leaf)
   -> Merkle.verifyProofKeccak(aggRoot, [], 1, 0, leaf)
   -> assert keccak256(leaf) == aggRoot   PASS
```

Why single-leaf: full Merkle aggregation requires a keeper that batches proofs off-chain. For V2A demo, each proof is its own 1-leaf aggregation tree. This is mathematically valid — a 1-leaf Merkle tree has root = keccak256(leaf).

### The statementHash function

statementHash is a view function on ShieldedPool.sol that encodes the public inputs into a format zkVerify expects:

```solidity
function statementHash(uint256[] inputs) public view returns (bytes32) {
    // Encodes: PROVING_SYSTEM_ID, VERSION_HASH, vkHash,
    //          then each public input with endianness correction
    // The exact encoding must match zkVerify's leaf format spec
}
```

This is critical — if the leaf encoding diverges between the route and what the contract expects, verifyProofAggregation always returns false, causing InvalidProof revert (surfaces as "gas estimate 140M" in the frontend).

---

## Part 6: Frontend Architecture

### Note Discovery Flow (Withdraw tab)

```typescript
// 1. Load notes from encrypted localStorage
const notes = await loadNotes(address, noteKey);

// 2. For each note, build flush status map in parallel
const flushStatusMap = new Map();
await Promise.all(notes.map(async (note) => {
    const logs = await getAllLogs(publicClient, SHIELDED_POOL_ADDRESS);
    const found = logs.find(l =>
        l.topics[0] === LEAF_INSERTED_TOPIC &&
        l.topics[1] === commitment
    );
    flushStatusMap.set(note.nullifierHash, found ? "ready" : "pending");
}));

// 3. Epoch countdown for pending notes
const effectiveLastEpochBlock = max(hookValue, localFlushBlock);
// localFlushBlock is set immediately on flush receipt
// prevents stale 12s polling window from showing wrong state
```

### Repay Loan Discovery

```typescript
// Auto-discover active loans from vault notes
await Promise.all(savedNotes.map(async (note) => {
    const hasActive = await publicClient.readContract({
        functionName: "hasActiveLoan", args: [note.nullifierHash]
    });
    if (!hasActive) return;

    const loanId = await publicClient.readContract({
        functionName: "activeLoanByNote", args: [note.nullifierHash]
    });

    const details = await publicClient.readContract({
        functionName: "getLoanDetails", args: [loanId]
    });

    results.push({ loanId, noteLabel: noteLabel(note), ...details });
}));
```

### Why totalOwed is re-fetched at repay time

Interest accrues per block (~2s on Base Sepolia). The `totalOwed` stored in component state was read when the loans loaded — potentially minutes ago. By repay time, `msg.value` (from stale state) < actual `totalOwed` → `InsufficientRepayment` revert → viem gas estimation fails → "exceeds max transaction gas limit."

Fix: re-read getLoanDetails immediately before writeContractAsync, add 0.1% buffer. Contract refunds overpayment.

---

## Explaining to the Instructor / Community

### The 30-second pitch

"ShieldLend V2A uses ring ZK proofs and epoch batch insertion to let you deposit ETH and later withdraw it to a different address — with no on-chain link between them. Even at protocol launch with zero other users, the anonymity set is 300+ because the protocol itself inserts dummy commitments. The lending layer lets you borrow against your shielded note without revealing which note is yours or how much collateral you have."

### Key technical talking points

1. Poseidon hash — designed for ZK circuits, ~8x fewer constraints than SHA256. Used for commitments AND Merkle tree hash on-chain — they MUST be identical or every proof fails.

2. Ring proofs vs tree proofs — ring proofs decouple withdrawal timing from deposit timing. The user proves membership in a local ring of K=16, not the entire global tree at a specific point in time.

3. Epoch batching + prevrandao — batches hide which deposit belongs to which note in each flush. prevrandao is unmanipulable by block proposers.

4. Dummy commitments — protocol-inserted synthetic leaves pad every epoch, giving 300+ anonymity set independent of real user volume.

5. Vault-strategy separation — ShieldedPool holds all ETH. LendingPool is accounting-only. This prevents a borrow bug from draining the vault directly.

6. Single-leaf aggregation — the zkVerify integration uses leaf = statementHash([root, nullifierHash, uint160(recipient), amount]), aggRoot = keccak256(leaf). A 1-leaf Merkle tree is trivially valid.
