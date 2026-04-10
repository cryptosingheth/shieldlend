# ShieldLend Architecture Decision Records

This document captures every significant design decision made during ShieldLend development — **why** each choice was made, what alternatives were rejected, and what consequences followed. It is a living document: new ADRs are appended automatically at the end of each session where a design decision is made or changed.

Format:
```
### ADR-N: Title
**Status**: Decided | Superseded (by ADR-X)
**When**: Session N / Version label
**Decision**: One sentence summary.
**Alternatives considered**: What else was evaluated.
**Rationale**: Why this choice was made.
**Consequences**: What this decision enables or constrains going forward.
```

---

## ZK Proof System

### ADR-01: Use Groth16 over STARK or PLONK
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Use Groth16 (via snarkjs + Circom) as the zero-knowledge proof system.  
**Alternatives considered**:
- STARK (StarkWare): proofs are ~50–200KB on-chain; no trusted setup needed but much larger verification cost
- PLONK: universal trusted setup (no circuit-specific ceremony) but not supported by snarkjs/Circom at time of decision; Barretenberg/Noir ecosystem only
- FFLONK: even smaller proofs than Groth16 but tooling immaturity

**Rationale**: Groth16 produces the smallest proof size (3 BN254 curve points, ~256 bytes). zkVerify aggregation means we never verify Groth16 on-chain directly — verification reduces to two `mapping` lookups in ZkVerifyAggregation. This makes the on-chain cost essentially zero regardless of proof system, so we optimize for proof generation speed and ecosystem compatibility. snarkjs + Circom is the most mature browser-compatible Groth16 stack.  
**Consequences**: Circuit-specific trusted setup required per circuit. Two circuits exist (withdraw_ring, collateral_ring) — each needed a separate Powers of Tau ceremony. Cannot change circuit without new trusted setup + redeployment.

---

### ADR-02: Use Circom DSL over Noir or Halo2
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Write ZK circuits in Circom 2.x.  
**Alternatives considered**:
- Noir (Aztec): uses Barretenberg backend + UltraPlonk proving system — no Groth16 output; incompatible with snarkjs
- Halo2 (Zcash/Electric Coin Co): Rust-native, no browser proving, different constraint model
- Cairo (StarkWare): generates STARK proofs, not Groth16

**Rationale**: Circom directly compiles to R1CS (Rank-1 Constraint System), which is the input format Groth16 requires. snarkjs handles the full pipeline: compile → witness → prove → verify, with browser WASM output. The developer stack is JS/TypeScript + Solidity — Circom fits naturally; Rust-native toolchains (Halo2, Cairo) do not.  
**Consequences**: All circuit code is Circom. Any future circuit must also be Circom unless a full toolchain migration is undertaken.

---

### ADR-03: Use Poseidon hash over MiMC or Keccak256
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Use Poseidon hash for all in-circuit commitments, nullifiers, and Merkle tree nodes.  
**Alternatives considered**:
- Keccak256: ~100,000 constraints per call in Circom — cannot practically use in-circuit (would make proof generation impossibly slow)
- MiMC: fewer constraints than Keccak but older, less audited, not as widely standardized
- Pedersen: good for commitments but not efficient as a general hash in circuits

**Rationale**: Poseidon was designed specifically for ZK circuits. It has ~180 constraints per call, making it practical for Merkle tree depths of 24 (24 × ~180 = ~4,320 constraints for the Merkle path alone). It is now the ZK hash standard used in Zcash Orchard, Filecoin, Polygon, and most production ZK systems.  
**Consequences**: On-chain Solidity also needs Poseidon for contract-side Merkle tree insertions. Deployed `PoseidonT3` library at `0x30F4D804AF57f405ba427dF1f90fd950C27c1Cc8`. Any change to on-chain hash function requires redeployment of all shards.

---

### ADR-04: Merkle tree depth 24
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Set the Merkle tree depth to 24 levels.  
**Alternatives considered**:
- Depth 20 (Tornado Cash standard): supports 2^20 = 1,048,576 leaves; simpler circuit
- Depth 32: supports 4B+ leaves; adds ~1,440 Poseidon constraints (~8 levels × 180)

**Rationale**: Depth 24 supports 2^24 = 16,777,216 leaves. This is sufficient for long-term scaling without being wasteful. Extra circuit cost over depth 20 is ~720 constraints (4 levels × 180) — negligible compared to the ring proof overhead (~14,000 constraints). Future expansion headroom justifies the minor circuit size increase.  
**Consequences**: Merkle proofs are 24 siblings. Frontend Merkle path computation must produce exactly 24 levels. Smart contract `LEVELS = 24` constant must never be changed without redeployment and circuit rebuild.

---

### ADR-05: Ring proof K=16 (16 plausible ring members)
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Use K=16 ring members in the withdraw_ring circuit.  
**Alternatives considered**:
- K=4: poor anonymity set (4 possible depositors per withdrawal)
- K=8: moderate anonymity; half the circuit size of K=16
- K=32: strong anonymity; doubles circuit size; proof generation ~2.5s in browser
- K=64: very strong anonymity; 4× circuit size; too slow for interactive use

**Rationale**: K=16 gives 16 plausible depositors per withdrawal — meaningfully larger than Tornado Cash's anonymity set (which has no ring proof at all). Proof generation time in browser is ~1.2 seconds at K=16, which is acceptable UX. Circuit constraint count is ~28,000 — practical for snarkjs browser WASM.

This is a feature unique to ShieldLend: Tornado Cash reveals that "exactly one of these depositors withdrew" but does not obscure which leaf is the real one beyond the Merkle membership proof. ShieldLend's ring proof cryptographically proves "I know the secret for one of these K leaves" without revealing which one.  
**Consequences**: All K=16 public witnesses must be valid Merkle members (leaves in the tree). Frontend must sample 15 random ring members + 1 real note per withdrawal. Circuit cannot be used with K≠16 without recompiling.

---

### ADR-06: Fixed denominations (0.05, 0.1, 0.5 ETH)
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Restrict deposits to fixed denominations: 0.05 ETH, 0.1 ETH, 0.5 ETH.  
**Alternatives considered**:
- Variable amounts: any ETH amount can be deposited
- More denomination tiers: 0.01, 0.05, 0.1, 0.5, 1.0, 10.0 ETH

**Rationale**: Variable amounts create unique on-chain fingerprints. A deposit of 0.13742 ETH followed by a withdrawal of 0.13742 ETH is trivially linked regardless of ZK proof privacy. Fixed denominations make all notes at the same denomination fungible — any 0.5 ETH note is indistinguishable from any other 0.5 ETH note. This is the same pattern Tornado Cash uses.

Critical V2B implication: cross-shard withdrawals only work because all 5 shards share the same `vkHash`. The `vkHash` is computed from the withdraw_ring circuit which encodes `denomination` as a public signal. If denominations were variable, each amount would need a different circuit → different vkHash → cross-shard proofs would fail. Fixed denominations are therefore a prerequisite for the V2B privacy model.  
**Consequences**: Users must split deposits into valid denominations. Borrowing is constrained to note value. Adding new denominations requires new circuit deployment + new shard deployment.

---

### ADR-07: Separate collateral_ring circuit (does not spend nullifier)
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Create a separate `collateral_ring.circom` circuit for proving note ownership during borrowing.  
**Alternatives considered**:
- Reuse withdraw_ring with a "no-spend" mode flag: adds complexity to circuit, mixes concerns
- Non-ZK collateral: expose note commitment directly (breaks privacy)

**Rationale**: The borrow flow requires proving "I own note X" WITHOUT spending it — the nullifier must remain unspent so the note can serve as collateral (locked, not consumed). `withdraw_ring.circom` outputs `nullifierHash` and expects the contract to mark it spent. A separate circuit was needed that outputs `nullifierHash` for collateral locking but does NOT use nullifier-spend logic. LendingPool calls `lockNullifier(nullifierHash)` — the note is locked but not spent.  
**Consequences**: Two separate trusted setups (one per circuit). Two separate `vkHash` values in the deployed contracts. Collateral proofs and withdrawal proofs cannot be mixed. Frontend must use the correct circuit file for each operation.

---

## Epoch Privacy

### ADR-08: 50-block epoch batching
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Accumulate deposits in a pending queue for 50 blocks before inserting them into the Merkle tree.  
**Alternatives considered**:
- Immediate insertion: each deposit inserts leaf immediately
- Longer epochs (200 blocks): stronger privacy but 6+ minute wait for withdrawal eligibility
- Variable epochs: adaptive based on pending count

**Rationale**: Without batching, if Alice deposits at block N and the next withdrawal happens at block N+1, there is only one note in the tree — the withdrawal is trivially linked to Alice's deposit. Batching forces multiple independent deposits to accumulate before any note can be withdrawn. 50 blocks ≈ 100 seconds on Base L2 (2s block time). This is enough time for multiple depositors to accumulate while remaining a reasonable UX wait time.  
**Consequences**: Withdrawals require waiting for `flushEpoch()` to be called after the current epoch ends. Frontend epoch countdown shows remaining blocks. Anyone can call `flushEpoch()` — it is permissionless. Caller receives a small tip (ETH) incentivizing third parties to flush.

---

### ADR-09: Fisher-Yates shuffle + adaptive dummy insertions
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: Shuffle the pending commitment queue using Fisher-Yates before Merkle insertion, and insert adaptive dummy leaves alongside real commitments.  
**Alternatives considered**:
- No shuffle: insertion order = deposit order; timing linkability preserved
- Fixed dummies (always 10): simpler but predictable; adversary can count dummies to identify real leaves
- No dummies: batch is small (1-3 real deposits); timing still reveals which leaf is real

**Rationale**: Even with epoch batching, if deposits are inserted in order, an observer who knows "Alice deposited as the 3rd deposit this epoch" can use the `LeafInserted` event order to identify which leaf is Alice's. Fisher-Yates randomizes the insertion order. Adaptive dummies (10 per epoch when pool has <200 real deposits, 5 per epoch after) make the real:dummy ratio unpredictable. An adversary cannot determine "this batch has 3 real + 10 dummy = my note is at position [K]" because the count varies.  
**Consequences**: `LeafInserted` event emits the real Merkle tree index (not queue position — this was Bug 2 fixed in V2A audit). Frontend uses `LeafInserted` events to find the correct `leafIndex` for proof generation. `totalDummiesInserted` is tracked explicitly (ADR-10).

---

### ADR-10: Explicit `totalDummiesInserted` tracking (Bug 3 fix)
**Status**: Decided (replaces original inline formula)  
**When**: Session 6 / V2A security audit  
**Decision**: Track `totalDummiesInserted` as an explicit state variable rather than computing it from `nextIndex - epochNumber * DUMMIES_PER_EPOCH`.  
**Alternatives considered**:
- Keep the formula but clamp at 0: prevents underflow but still inaccurate after adaptive switch
- Recompute per epoch: gas-intensive loop

**Rationale**: The original formula assumed exactly `DUMMIES_PER_EPOCH` (10) dummies per epoch always. Once the adaptive rate switched to 5 (pool > 200 real deposits), the formula `nextIndex - epochNumber * 10` underflowed when `epochNumber * 10 > nextIndex`. This was a critical arithmetic bug that would cause `flushEpoch()` to revert after ~47 epochs at 5 dummies/epoch. The fix is to increment `totalDummiesInserted += dummyCount` inside `_insert()` — an explicit counter that is always accurate regardless of adaptive rate changes.  
**Consequences**: `totalDummiesInserted` is a public state variable. Tests can verify dummy tracking accuracy directly. Future changes to adaptive dummy logic must also update the increment call.

---

## Privacy Features A–E

### ADR-11: ERC-5564 stealth addresses for withdrawal recipients (Feature A)
**Status**: Decided  
**When**: Session 6 / V2A+  
**Decision**: Generate a fresh ERC-5564 stealth address as the withdrawal recipient instead of the user's MetaMask wallet address.  
**Alternatives considered**:
- User manually inputs a recipient address: still linkable if they use a known address
- One-time server-generated address: server knows the mapping; trusted party required
- User generates a fresh wallet: UX friction; user must track private keys manually

**Rationale**: Without stealth addresses, the withdrawal chain is: `stealth_address ← ShieldedPool ← relay ← user_wallet`. The withdrawal recipient IS the user's wallet — the privacy of the ring proof is completely undermined at the final step. ERC-5564 Scheme 1 uses two HKDF-derived keys (spend key + view key) and an ephemeral ECDH exchange to produce a fresh address per withdrawal that is mathematically linked to the user's keys but computationally unlinkable to observers. No on-chain history, no reuse. `@scopelift/stealth-address-sdk` implements the derivation. User recovers funds by importing the computed private key into MetaMask.  
**Consequences**: User must import a private key after each withdrawal to access funds — added friction vs. direct wallet transfer. `stealthKeyContext.tsx` derives keys from a single MetaMask signature (cached per session). Second and subsequent withdrawals reuse cached keys — only one signature prompt per session.

---

### ADR-12: Server-side deposit relay (Feature B)
**Status**: Decided  
**When**: Session 6 / V2A+  
**Decision**: Route all deposit transactions through a Next.js API route (`/api/deposit`) that uses the server's deployer wallet to submit the on-chain transaction.  
**Alternatives considered**:
- User submits deposit directly: `tx.from = user_wallet`, permanently linkable on-chain
- Tornado Cash-style relayer network: decentralized but complex; no relayer infrastructure exists for ShieldLend
- Flashbots-style private mempool: hides from mempool but `tx.from` still visible in confirmed block

**Rationale**: Even with stealth addresses and ZK proofs, if Alice's wallet (`0xAlice`) is visible in the deposit transaction's `from` field, the privacy model is broken. An observer can follow: `0xAlice` → ShieldedPool deposit → (some time later) → ShieldedPool withdrawal → `0xFreshStealth`. Server relay makes the deposit `from` the server wallet (`0x6D4b...Fb2`) instead. Alice's wallet never touches any on-chain transaction in the full deposit → borrow → repay → withdraw flow.  
**Consequences**: Server wallet must hold ETH float for all deposits. On testnet: funded by faucet. On mainnet: requires deposit float management strategy (users pay server in advance, or fee deducted from note). Server is a trusted intermediary for liveness (can censor deposits) but NOT for privacy (cannot link deposit to user since the commitment is generated client-side).

---

### ADR-13: Viewing keys as a separate HKDF derivation chain (Feature C)
**Status**: Decided  
**When**: Session 6 / V2A+  
**Decision**: Derive a separate AES-256-GCM viewing key via HKDF using a different salt/info string than the note encryption key.  
**Alternatives considered**:
- Reuse note key as viewing key: sharing note key reveals nullifier/secret — auditor could spend notes
- Generate viewing key from random entropy: key is lost if localStorage clears; no deterministic recovery

**Rationale**: This is the Zcash transparent disclosure model. The viewing key is derived deterministically from the same wallet signature as the note key, but via a different HKDF path — the two keys are cryptographically independent. An auditor given the viewing key hex can decrypt all note ciphertexts stored in Deposit events (Feature D) but cannot derive the ZK witness (nullifier, secret) needed to generate a withdrawal proof. "Read but cannot spend" is the invariant.  
**Consequences**: `viewingKeyContext.tsx` manages viewing key lifecycle. `loadNotesWithViewingKey()` in `noteStorage.ts` enables auditor-facing note decryption. Viewing key export is a hex string suitable for sharing out-of-band.

---

### ADR-14: On-chain encrypted note storage in Deposit event (Feature D)
**Status**: Decided  
**When**: Session 6 / V2A+  
**Decision**: Append `bytes encryptedNote` to the `Deposit` event and require it as a parameter in `ShieldedPool.deposit()`.  
**Alternatives considered**:
- localStorage only: unrecoverable if browser storage clears; no cross-device recovery
- IPFS note storage: requires pinning infrastructure; additional trust assumption; latency
- Plaintext note in event: catastrophic — reveals nullifier/secret publicly

**Rationale**: Notes (nullifier + secret + amount) are the ZK witnesses that prove ownership of a deposit. If they are lost (browser clear, new device), the deposited ETH is permanently locked — no proof can be generated. Storing an AES-256-GCM encrypted ciphertext in the Deposit event means the note survives any client-side state loss. Only the viewing key holder can decrypt it. The 256-byte cap on `encryptedNote` limits contract storage cost.  
**Consequences**: Note binary packing was required (ADR-22) because JSON serialization exceeded the cap. ShieldedPool.deposit() signature changed from `deposit(bytes32)` to `deposit(bytes32, bytes)` — V2A+ redeployment required. Frontend always passes `encryptedNote` derived from the viewing key.

---

### ADR-15: CREATE2 shard factory — 5 shards (Feature E)
**Status**: Decided  
**When**: Session 6 / V2A+  
**Decision**: Deploy 5 independent ShieldedPool contracts (shards) using CREATE2 from a `ShieldedPoolFactory`.  
**Alternatives considered**:
- Single pool: one address, simpler, but 100% blast radius on exploit
- 2 shards: partial blast radius reduction; less address diversity
- 10 shards: stronger obfuscation; higher deploy cost; liquidity too fragmented for borrowing

**Rationale**: Two independent motivations:
1. **Blast radius reduction**: A reentrancy exploit, price oracle attack, or storage collision on one shard can drain at most 20% of TVL. The other 4 shards remain safe. This is a direct security improvement — comparable to the security engineering principle of "compartmentalization" (one service per database, isolated network segments).
2. **Protocol obfuscation**: An on-chain observer sees deposits going to 5 different addresses. Without knowing all 5 addresses, they cannot even identify ShieldLend as the protocol. Tornado Cash uses the same pattern (separate contracts per denomination). Combined with relay (Feature B), each deposit goes to a randomly selected shard address — further reducing the signal density per address.

Inspired directly by Tornado Cash's per-denomination pool architecture. $15 one-time deploy cost. Zero per-transaction overhead.  
**Consequences**: All 5 shards share the same `vkHash` — cross-shard withdrawal works without circuit change (see ADR-23). LendingPool must track per-shard ownership of loans (collateralShard + disburseShard, ADR-18). NullifierRegistry must be shared across all shards to prevent cross-shard nullifier reuse.

---

## Contract Architecture

### ADR-16: LendingPool as accounting-only (no ETH custody)
**Status**: Decided  
**When**: Session 1 / V1  
**Decision**: LendingPool records loan state but never holds user ETH. All ETH stays in ShieldedPool shard contracts.  
**Alternatives considered**:
- LendingPool holds all ETH: simpler accounting but single point of failure
- LendingPool holds collateral, shards hold pool liquidity: splits ETH across more contracts, more complex

**Rationale**: Separation of concerns between ledger (LendingPool) and vault (ShieldedPool shards) is a standard DeFi security pattern. A LendingPool exploit — arithmetic bug, access control failure, oracle manipulation — cannot drain ETH because LendingPool has no ETH balance. An attacker would need to simultaneously exploit LendingPool AND a ShieldedPool shard. Defense in depth.  
**Consequences**: All ETH transfer logic is in ShieldedPool: `disburseLoan()`, `settleCollateral()`. LendingPool calls these as external calls. `settleCollateral` must forward `msg.value` to the correct disburse shard (ADR-18).

---

### ADR-17: NullifierRegistry as a separate contract (shared across shards)
**Status**: Decided  
**When**: Session 6 / V2A+  
**Decision**: Deploy one NullifierRegistry shared by all 5 ShieldedPool shards.  
**Alternatives considered**:
- Each shard has its own nullifier set: simpler per-shard but cross-shard nullifier reuse is possible
- NullifierRegistry logic inside LendingPool: would couple accounting to privacy-critical nullifier logic

**Rationale**: Without a shared nullifier registry, a nullifier spent on Shard 1 could be reused on Shard 2. This would allow double-spending: withdraw ETH from Shard 1, then withdraw the same note's ETH from Shard 2. The shared registry makes `isSpent(hash)` a global check. `NullifierRegistry` also has `isRegisteredShard` mapping — only registered shards can call `markSpent()`, preventing unauthorized nullifier manipulation.  
**Consequences**: NullifierRegistry is a critical infrastructure contract. Any upgrade requires redeploying all 5 shards (they store the NullifierRegistry address). `ShieldedPoolFactory` registers all shards automatically during deployment.

---

### ADR-18: Loan struct tracks both `collateralShard` and `disburseShard`
**Status**: Decided  
**When**: Session 6 / V2A+  
**Decision**: Store two shard addresses per loan: where the collateral note was locked (`collateralShard`) and where the ETH was disbursed from (`disburseShard`).  
**Alternatives considered**:
- Single `shardAddress` per loan: forces collateral and disburse to be the same shard
- Store only `disburseShard`, derive `collateralShard` from nullifier lookup: complex; requires shard-by-shard nullifier scanning

**Rationale**: In a multi-shard protocol with varying liquidity, the richest shard may not be the shard holding the collateral note. Separating the two addresses allows the server to pick the shard with the most available ETH for disbursement while locking the collateral where the note actually lives. Repayment and liquidation forward ETH to `disburseShard` (where it was sourced from), not `collateralShard`. This enables efficient liquidity utilization across shards.  
**Consequences**: `borrow()` requires two shard addresses as parameters. Server must check shard balances before calling borrow. `repay()`, `liquidate()`, and `settleCollateral()` all use `loan.disburseShard` for ETH forwarding.

---

### ADR-19: `nextLoanId` starts at 1 (0 is null sentinel)
**Status**: Decided  
**When**: Session 6 / V2A security audit, round 2  
**Decision**: Initialize `nextLoanId = 1` so that loan ID 0 is never assigned to a real loan.  
**Alternatives considered**:
- Start at 0 and use a separate `exists` bool per loan: more storage, more gas
- Start at 0 and add a `bool initialized` flag: same issue

**Rationale**: Solidity mappings return zero-structs for unset keys. If `nextLoanId` started at 0, `loans[0]` would be initialized to all-zeros and would be indistinguishable from "this loan ID doesn't exist." Callers checking `loans[someId].collateralShard == address(0)` would get a false match for ID 0. Using 1 as the first real ID makes 0 an unambiguous null value. This is a standard Solidity pattern for mappings.  
**Consequences**: First loan is `loanId = 1`. `loans[0]` is always a zero-struct, usable as "not found" sentinel. Any code that creates loans must use `nextLoanId++` AFTER assignment (or pre-increment before assignment).

---

### ADR-20: `nonReentrant` modifier on all state-changing functions
**Status**: Decided  
**When**: Session 6 / V2A security audit, round 1  
**Decision**: Apply OpenZeppelin ReentrancyGuard to: `withdraw()`, `flushEpoch()`, `disburseLoan()`, `repay()`, `liquidate()`, `settleCollateral()`.  
**Alternatives considered**:
- Checks-Effects-Interactions pattern without explicit guard: relies on correct ordering; audit-risky
- Only guard the highest-risk functions (withdraw, settle): partial protection; misses less obvious vectors

**Rationale**: Audit round 1 found that `withdraw()` made an external ETH call (`recipient.call{value: amount}`) before some state finalization paths were complete, and `settleCollateral()` made an external call before clearing the loan state. Any contract that receives ETH (e.g., a malicious borrower's contract) could re-enter either function. ReentrancyGuard is added to all functions with external calls — belt-and-suspenders. Gas cost: 1 cold SSTORE (~20,000 gas) per call, accepted.  
**Consequences**: Functions cannot be called recursively (by an external contract re-entering during execution). `flushEpoch()` tip transfer was moved before state updates to comply with checks-effects-interactions — the reentrancy guard alone is not sufficient if external calls precede state finalization.

---

### ADR-21: `pushRoot()` validates against `shard.getLastRoot()`
**Status**: Decided  
**When**: Session 6 / V2A security audit  
**Decision**: In `LendingPool.pushRoot()`, require `root == IShieldedPool(msg.sender).getLastRoot()` before adding root to global registry.  
**Alternatives considered**:
- Accept any root from any registered shard: simpler but allows arbitrary root injection
- Registry maintained by admin only: centralizes control; defeats the purpose of cross-shard withdrawal

**Rationale**: The global root registry (`mapping(bytes32 => bool) isValidRoot`) is used by ShieldedPool's `withdraw()` to accept roots from any registered shard. If any registered shard could call `pushRoot(arbitrary_bytes)` with a crafted root, an attacker who controls or exploits one shard could inject a root containing their own commitment — then withdraw against that fake root from any other shard. Validating `root == caller.getLastRoot()` ensures only actual, current Merkle roots can be registered.  
**Consequences**: Roots are pushed automatically by `ShieldedPool._insert()` after each `flushEpoch()`. The root validation is a single external view call — low gas overhead. Stale roots (from earlier epochs) are never re-pushed, only the current root at flush time.

---

## V2B Specific

### ADR-22: Binary packing for encrypted notes (72B plaintext → 100B AES-GCM output)
**Status**: Decided  
**When**: Session 7 / V2B  
**Decision**: Pack note fields into a 72-byte binary buffer instead of JSON-serializing the Note struct before AES-GCM encryption.  
**Alternatives considered**:
- JSON serialization: `{"nullifier":"0x...","secret":"0x...","amount":"500000000000000000"}` is ~390 bytes plaintext → ~418 bytes AES-GCM — exceeds the 256-byte `encryptedNote` cap in ShieldedPool.deposit()
- Raise the 256-byte cap: increases calldata cost on every deposit; cap exists for a reason (storage gas)
- Compress JSON (gzip): browser Compression Streams API has async complexity; still ~150 bytes minimum

**Rationale**: Three note fields are fixed-width integers: `nullifier` (uint256 = 32 bytes), `secret` (uint256 = 32 bytes), `amount` (uint256 but practically fits in 8 bytes for ETH amounts up to 18 ETH). Total plaintext: 72 bytes. AES-256-GCM adds 12-byte IV + 16-byte authentication tag = 28 bytes overhead → 100 bytes total. Well under the 256-byte cap.  
**Consequences**: Note deserialization must unpack the binary format (slice bytes at offsets 0, 32, 64). The `amount` field uses only 8 bytes (bottom 8 bytes of the 32-byte uint) — values above ~18 ETH would truncate. Acceptable for current denominations (0.05, 0.1, 0.5 ETH). Future denominations above ~18 ETH would need format revision.

---

### ADR-23: V2B cross-shard withdrawal — deposit shard X, withdrawal from random shard Y
**Status**: Decided  
**When**: Session 7 / V2B  
**Decision**: After locating a note on `depositShard`, pick a random `withdrawalShard` (≠ depositShard, sufficient ETH balance) for the actual withdrawal transaction.  
**Alternatives considered**:
- Always withdraw from depositShard (V2A behavior): creates linkability via shared shard address even though user wallet is absent
- Always withdraw from a fixed "withdrawal shard": predictable; provides no privacy benefit over V2A

**Rationale**: V2A privacy gap identified in session 7: even with relay (Feature B) and stealth addresses (Feature A), if Alice's deposit went to ShardPool_2 and her withdrawal also comes from ShardPool_2, an observer can correlate the two events via the common shard address. The user wallet is absent from both transactions, but the shard address connects them. V2B breaks this: withdrawal shard is randomly selected from the 4 remaining shards (excluding depositShard), provided the shard has enough ETH to cover the denomination. An observer now sees two unrelated shard addresses with no shared transaction history.

This is only possible because all shards share the same `vkHash` (ADR-06, ADR-15). A Merkle proof generated against ShardPool_2's root is valid from ShardPool_4's perspective because the statementHash is recomputed from public inputs (root, nullifierHash, recipient, denomination) — independent of which shard processes it. LendingPool's global root registry (ADR-21) accepts ShardPool_2's root when ShardPool_4 calls `isValidRoot()`.  
**Consequences**: WithdrawForm's `findShardForCommitment()` scans all 5 shards. Frontend must pass correct `shardAddress` (withdrawalShard) to the withdraw transaction. The proof is generated against depositShard's Merkle tree; the on-chain call is made to withdrawalShard. Both shard addresses are passed to `generateWithdrawProof()` for root retrieval.

---

### ADR-24: `hasActiveLoan()` in ILendingPool for cross-shard auto-settlement
**Status**: Decided  
**When**: Session 7 / V2B  
**Decision**: Add `hasActiveLoan(bytes32 nullifierHash)` to the ILendingPool interface; ShieldedPool.withdraw() calls this instead of checking its local `lockedAsCollateral` mapping.  
**Alternatives considered**:
- Keep per-shard `lockedAsCollateral` check: fails for cross-shard withdrawals (V2B) because the flag is only set on the deposit shard, not the withdrawal shard
- Emit an event when locking, have withdrawal shard scan events: complex; requires getLogs call; fragile on public RPC

**Rationale**: In V2B, a note locked as collateral on ShardPool_2 may be withdrawn via ShardPool_4. ShardPool_4's local `lockedAsCollateral[nullifierHash]` is always `false` — the lock was set on ShardPool_2. Without the global check, auto-settlement would silently skip loan repayment: the borrower's collateral would be consumed but the loan would remain unpaid. `hasActiveLoan(nullifierHash)` queries LendingPool's loan mapping directly — a global check that works regardless of which shard calls it.  
**Consequences**: One extra external view call per withdrawal (to LendingPool). `settleCollateral()` in V2B now explicitly calls `IShieldedPool(collateralShard).unlockNullifier(nullifierHash)` — it can no longer assume `msg.sender == collateralShard`. The `require(msg.sender == loan.collateralShard)` check was removed from `settleCollateral()` in V2B.

---

### ADR-25: Receipt-based log parsing instead of `getLogs` for testnet
**Status**: Decided  
**When**: Session 7 / V2B (live-test.mjs)  
**Decision**: In live-test.mjs T7 (Feature D verification), parse logs from the transaction receipt object instead of calling `eth_getLogs`.  
**Alternatives considered**:
- `eth_getLogs` with exact block range: public Base Sepolia RPC rejects same-block ranges with "Invalid parameters"
- `eth_getLogs` with ±1 block offset: still rejected on some block ranges by public RPC
- Use Alchemy/Infura paid RPC: solves the issue but adds external dependency to test script

**Rationale**: `waitForTransactionReceipt()` returns the full receipt including the `logs` array. Every log emitted in that transaction is present — no block range query needed. Parsing from the receipt is more reliable, faster (no separate network call), and works on any RPC including public endpoints. The receipt log format is identical to `getLogs` output — same `topics`, `data`, `address` fields. The fix is to store `depositReceipt` in test T6 and parse it in T7 without issuing any `eth_getLogs` call.  
**Consequences**: T7 now depends on T6 completing successfully (receipt stored in shared variable). Tests are slightly order-dependent but this is acceptable in a sequential live-test script. Pattern can be reused for any future test that needs event log data from a specific transaction.

---

*Last updated: Session 7 / V2B — 2026-04-11*  
*Next update: auto-appended at end of next session with design changes (see CLAUDE.md)*
