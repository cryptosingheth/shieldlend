# ShieldLend Privacy Architecture — V2A and V2A+

This document describes the complete privacy model: what exists in V2A (deployed), what is planned in V2A+, and why each design decision was made.

---

## The Core Privacy Problem

A naïve ZK lending protocol still leaks identity at two transaction surfaces:

1. **Deposit**: `tx.from` = user's wallet → depositor is publicly visible on-chain
2. **Withdrawal**: `recipient` = user's wallet → withdrawer is publicly visible on-chain

Even with a perfect ring proof, if the same address appears in both transactions, an observer trivially de-anonymizes the user. V2A+ closes both leaks.

---

## V2A — Deployed Privacy Layers

### Layer 1: Browser (Note Encryption)
- Notes are encrypted with AES-256-GCM before being stored in localStorage
- Key = HKDF(SHA-256, MetaMask wallet signature as seed)
- Separate signing message ensures the key is purpose-bound
- Cross-device: same wallet → same signature → same key (deterministic)
- Nullifier and secret never leave the browser

### Layer 2: ZK Circuits (Ring Proof)
- `withdraw_ring.circom`: K=16 ring membership + depth-24 Merkle inclusion + nullifier binding
- Ring sampled from last 30 epoch flushes → anonymity set ≥ 300 at launch
- `ring_index` (which commitment is the prover's) is PRIVATE — verifier sees 16 commitments, not which one
- Commitment formula: `Poseidon(secret, nullifier, denomination)` — denomination is bound to prevent underpayment
- `nullifierHash = Poseidon(nullifier)` — ring-index removed (H-3 fix) → prevents cross-ring replay

### Layer 3: Smart Contracts (Vault Design)
- Single ETH vault (ShieldedPool); LendingPool is accounting-only — no ETH custody
- `Borrowed(loanId)` event emits ONLY the loan ID — no amount, no recipient in logs
- Nullifier locking: collateral note is locked in ShieldedPool; auto-settle atomically repays loan on withdrawal
- `NullifierRegistry` prevents double-spend across the entire protocol

### Layer 4: zkVerify (Off-Chain Proof Verification)
- Groth16 proof verified on Volta testnet (91% cheaper than EVM)
- Single-leaf aggregation: `statementHash([root, nullifierHash, uint160(recipient), amount])`
- On-chain verification via `verifyProofAggregation()` — no raw proof calldata on Base Sepolia

### Layer 5: Epoch Batching
- Commitments queue for 50 blocks before Merkle insertion
- `flushEpoch()` shuffles with `block.prevrandao` (Fisher-Yates) → breaks ordering correlation
- Adaptive dummy commitments inserted each epoch (2/5/10 based on protocol volume)
- `LeafInserted` leaf index ≠ deposit queue index → timing correlation broken

---

## V2A+ — Planned Privacy Features

### Feature A: Stealth Addresses for Withdrawal (ERC-5564)

**Problem**: Withdrawal `recipient` is currently the user's connected wallet — visible on-chain.

**Design**: Per-withdrawal fresh address derived via ECDH (ERC-5564 Scheme 1).
- User derives a **stealth meta-address** from a wallet signature (once per session):
  - `spendKey` + `viewKey` derived via HKDF from the signature using `deriveBits`
  - Public keys derived using `@noble/secp256k1` → `getPublicKey(privBytes, true)` (compressed, 33 bytes)
  - Meta-address URI: `st:eth:0x<spendPub_33bytes_hex><viewPub_33bytes_hex>` (141 chars)
- At withdrawal time:
  - `generateStealthAddress(metaAddressURI)` → fresh `stealthAddress` + `ephemeralPublicKey`
  - This `stealthAddress` is passed as the withdrawal `recipient` (not the user's wallet)
  - After confirmation: `computeStealthKey(ephemeralPubKey, spendKey, viewKey, SCHEME_ID_1)` → private key to import into MetaMask

**Why no ERC-5564 Announcer contract**: The announcer is for Bob scanning to find funds Alice sent him. In ShieldLend, the user sends to themselves. They generated the ephemeral key → they immediately compute the stealth private key. No event scanning needed.

**On-chain result**: `ShieldedPool.withdraw(..., recipient=0xFreshStealth, ...)` — user's wallet absent.

### Feature B: Server-Side Deposit Relay

**Problem**: Deposit `tx.from` is the user's wallet — visible on-chain.

**Design**: Next.js API route (`POST /api/deposit`) submits the deposit on the user's behalf using the server's deployer wallet.
- `ShieldedPool.deposit()` has no access control and does not reference `msg.sender`
- The `Deposit` event does not include the sender address
- User computes the commitment client-side (secret + nullifier never leave browser)
- User sends `{ commitment, denomination }` to the server API
- Server calls `deposit(commitment)` with the correct ETH value from its own balance
- Server wallet is pre-funded from faucet (testnet)

**On-chain result**: `tx.from = 0xServerDeployer` — user's wallet absent from both deposit and withdrawal.

### Feature C: Viewing Keys for Auditor Disclosure

**Problem**: No way to prove transaction history to a regulator or auditor without revealing spending keys.

**Design**: Separate AES-256-GCM key derived from a different HKDF chain.
- Signing message: `"ShieldLend: unlock viewing access\n\nAllows note history disclosure to auditors. Cannot spend funds."`
- Key is `extractable: true` → user can export as hex and share with auditor
- Each note is double-encrypted: once with the note key (for spending), once with the viewing key (for disclosure)
- Auditor with viewing key hex can decrypt note history (amounts + commitments)
- Auditor CANNOT generate ZK proofs — they have no `nullifier` or `secret`

### Feature D: Zcash-Style Encrypted Notes On-Chain

**Problem**: If localStorage is wiped, notes are unrecoverable (no backup mechanism).

**Design**: AES-256-GCM ciphertext of the note is passed as `bytes encryptedNote` in `deposit()`.
- Contract stores it in the `Deposit` event (opaque bytes — no denomination or secret visible)
- With the viewing key, any client can scan all `Deposit` events and decrypt their own notes
- Requires contract redeployment (adds `bytes calldata encryptedNote` parameter)
- No circuit change

### Feature E: CREATE2 Shard Factory + Cross-Shard Withdrawal

**Problem**: A single ShieldedPool address is a single blast radius — one exploit drains 100% of TVL. The fixed pool address also lets an observer identify ShieldLend as the intermediary.

**Design**: 5 identical ShieldedPool contracts deployed at different addresses via a CREATE2 factory.

#### What this achieves

| Observer sees | Before | After |
|---------------|--------|-------|
| Deposit `tx.to` | `ShieldedPool` (0xABC, always same) | `ShardPool_2` (0x111, randomly assigned) |
| Withdrawal `tx.from` | `ShieldedPool` (0xABC, always same) | `ShardPool_4` (0x333, different shard) |
| Max funds at risk per exploit | 100% | 20% |

This is **protocol-level obfuscation**: an on-chain observer cannot identify ShieldLend as the intermediary without knowing all 5 shard addresses. Tornado Cash uses the same pattern (separate contracts per denomination). ShieldLend is different — same circuit for all shards — which enables the cross-shard feature below.

#### Cross-Shard Withdrawal (novel — no circuit change)

All 5 shards use the **same Circom circuit** with the **same `vkHash`**. A Groth16 proof generated against ShardPool_2's Merkle root is a valid proof for inputs `[root_of_shard2, nullifierHash, recipient, denomination]`. When ShardPool_4 calls `_verifyAttestation()` with those inputs, it recomputes the identical `statementHash` and zkVerify's attestation passes.

**The only blocker**: `isKnownRoot(root)` checks against the local shard's root history.

**Fix**: LendingPool maintains a global root registry (`mapping(bytes32 => bool) isValidRoot`). Each shard calls `LendingPool.pushRoot(newRoot)` after every `_insert()`. Withdrawal accepts any root in the global registry.

```
Deposit → ShardPool_2 → root_2 pushed to LendingPool global registry
Withdraw → ShardPool_4 → isKnownRoot(root_2) = false → check LendingPool.isValidRoot(root_2) = true → PASS
```

This cross-shard pattern is only possible because ShieldLend uses **fixed denominations with a single shared circuit**. Tornado Cash cannot do this — each denomination uses a different circuit with a different `vkHash`. Variable amounts would also break it (each amount would need a separate vkHash). Fixed denominations are not just a simplification — they are the architectural prerequisite for cross-shard fungibility.

#### Cross-Shard Borrow Liquidity

`collateralShard` and `disburseShard` are stored separately in the Loan struct. When a user borrows:
- The collateral note is locked in `collateralShard` (the shard where the deposit lives)
- ETH is disbursed from `disburseShard` (the shard with most available liquidity — server-selected)

This prevents borrow reverts due to per-shard liquidity fragmentation. The server queries all shard balances before calling `borrow()` and routes to the richest shard.

#### LendingPool: Single Accounting Layer

LendingPool remains the single ledger for all loans across all shards:
- `mapping(address => bool) isRegisteredShard` — replaces single `shieldedPool` address
- `address[] registeredShards` — for interest rate utilization (sums balances across all shards)
- `onlyShieldedPool` modifier: `require(isRegisteredShard[msg.sender])` — accepts calls from any shard
- `repay()` routes ETH back to `loan.disburseShard`
- `liquidate()` unlocks collateral in `loan.collateralShard`, returns ETH to `loan.disburseShard`
- Interest rate: `_currentRate()` sums `registeredShards[i].balance` for accurate protocol-wide utilization

**Blast radius**: exploiting one shard affects at most 20% of TVL. The other 4 shards remain intact.

---

## Complete Privacy Model (After All V2A+ Features)

| What observer sees on-chain | V2A (current) | V2A+ (planned) |
|-----------------------------|---------------|-----------------|
| Deposit `tx.from` | User's wallet | Server wallet — user absent |
| Deposit `tx.to` | Fixed ShieldedPool | Random shard address |
| Withdrawal `tx.from` | Fixed ShieldedPool | Any shard (deposit shard ≠ withdraw shard possible) |
| Withdrawal `tx.to` | User's wallet | Fresh stealth address |
| Deposit event payload | commitment, index, time, amount | Same + encrypted note ciphertext |
| Loan event payload | loanId only (already private) | loanId only |
| Two withdrawals same user | Same recipient address | Different stealth addresses, no shared ancestry |
| Note recovery if localStorage wiped | Impossible | Decrypt from chain events using viewing key |
| Proving history to auditor | Impossible | Share viewing key hex |
| Max funds lost in one exploit | 100% TVL | 20% TVL (1 shard) |

---

## What V2A+ Does NOT Change

- **No circuit changes**: same `withdraw_ring.circom`, same `collateral_ring.circom`, same trusted setup
- **No new proving keys**: existing `.zkey` files work unchanged
- **No zkVerify reconfiguration**: same VK hash, same domain ID, same aggregation pattern
- **No denomination changes**: fixed denominations (0.001/0.005/0.01/0.05/0.1/0.5 ETH) remain
- **No frontend proof generation changes**: same Groth16 inputs, same public signals

The privacy upgrade requires contract redeployment (ShieldedPool ABI changes for Feature D; new shard contracts for Feature E) and frontend additions (new context files, new API route) but zero ZK infrastructure changes.

---

## Implementation Files (V2A+)

| File | Change | Feature |
|------|--------|---------|
| `frontend/package.json` | Add `@noble/secp256k1@^2.0.0` | A |
| `frontend/src/lib/stealthKeyContext.tsx` | CREATE | A |
| `frontend/src/lib/viewingKeyContext.tsx` | CREATE | C |
| `frontend/src/lib/noteStorage.ts` | Add `viewingCipher` + encrypt/decrypt helpers | C, D |
| `frontend/src/app/api/deposit/route.ts` | CREATE — server deposit relay | B |
| `frontend/src/components/DepositForm.tsx` | Route through API; add encrypted note | B, D |
| `frontend/src/components/WithdrawForm.tsx` | Remove recipient field; auto stealth address | A |
| `frontend/src/app/providers.tsx` | Add StealthKeyProvider + ViewingKeyProvider | A, C |
| `contracts/src/ShieldedPool.sol` | Add `encryptedNote` to deposit(); add `pushRoot()` call in `_insert()`; update root check in `withdraw()` | D, E |
| `contracts/src/ShieldedPoolFactory.sol` | CREATE — deploy 5 shards via CREATE2 | E |
| `contracts/src/LendingPool.sol` | Shard registry; global root registry; split collateralShard/disburseShard; update all ETH routing | E |
