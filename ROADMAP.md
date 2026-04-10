# ShieldLend — Project Roadmap

This document tracks what has been built and what remains. The V2A architecture is fully deployed on Base Sepolia.

---

## V2A Status — Base Sepolia (Chain ID 84532)

| Phase | Status |
|-------|--------|
| Circuits: `withdraw_ring.circom`, `collateral_ring.circom` | ✅ Compiled, trusted setup done, H-1/H-3 fixed |
| Contracts: ShieldedPool, LendingPool, NullifierRegistry, ZkVerifyAggregation | ✅ Deployed (3rd deployment) |
| Frontend: Deposit, Withdraw, Borrow, Repay, History | ✅ Built |
| zkVerify integration (Volta testnet) | ✅ Integrated |
| End-to-end: Deposit → Withdraw | ✅ Confirmed live |
| End-to-end: Borrow → Repay | 🔜 Pending live test |
| Security: Access control on borrow (C-1) | ⚠️ Open critical finding |

---

## Deployed Contracts — Base Sepolia (current V2A)

| Contract | Address |
|----------|---------|
| ShieldedPool | `0x9365e995F8aF1051db68100677a6C9cf225055A9` |
| LendingPool | `0x1aacF59792404b23287Faa9b0fbC3c9505cc56c9` |
| NullifierRegistry | `0xD0e7D0A083544144a4EFf2ADAa6318E3a28722e7` |
| ZkVerifyAggregation | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` |

zkVerify: Volta testnet | Domain ID: 0 | VK hash (withdraw_ring): `0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572`

---

## V2A+ Privacy Features — Next Implementation Phase

The V2A+ phase closes the two remaining privacy gaps: deposit `tx.from` reveals the user's wallet, and withdrawal recipient is the user's wallet. See [`docs/privacy-architecture.md`](docs/privacy-architecture.md) for the complete design.

| Feature | Description | Contract Change | Circuit Change |
|---------|-------------|-----------------|----------------|
| A. Stealth withdrawal addresses | ERC-5564 per-withdrawal fresh ECDH address | No | No |
| B. Server-side deposit relay | API route submits deposit on user's behalf | No | No |
| C. Auditor viewing keys | Separate HKDF key for selective disclosure | No | No |
| D. Zcash-style encrypted notes | `bytes encryptedNote` in deposit() event | Yes (redeployment) | No |
| E. CREATE2 shard factory + cross-shard withdrawal | 5 shards; global root registry; cross-shard proof fungibility | Yes (new contracts) | No |

### What Makes Feature E Novel

All 5 shards use the **same circuit** with the **same `vkHash`**. A proof generated against ShardPool_2's Merkle root is cryptographically valid on ShardPool_4 — the only check that differs is `isKnownRoot()`. A global root registry in LendingPool (`pushRoot()` called on every `_insert()`) makes any shard's root acceptable at any other shard.

**This is impossible in Tornado Cash** (separate circuits per denomination, different vkHash per pool) and **impossible with variable amounts** (each amount would need its own trusted setup). Fixed denominations with a single shared circuit are the prerequisite for cross-shard withdrawal fungibility. ShieldLend is the first protocol to achieve this pattern.

---

## Next Steps

### 1. Live-test borrow flow
- Select a flushed note → enter borrow amount → ZK proof (~25s) → zkVerify → `borrow()` tx
- Confirm `Borrowed(loanId)` event in History

### 2. Live-test repay flow
- Select loan from dropdown → click Repay → confirm `Repaid(loanId, totalRepaid)` event

### 3. Implement V2A+ privacy features (all 5 features — see plan)
Implementation order: A (stealth) → B (deposit relay) → C (viewing keys) → D (encrypted notes) → E (sharding)
Full specification: [`docs/privacy-architecture.md`](docs/privacy-architecture.md)

### 4. Fix C-1: Borrow access control (before any public demo)
`LendingPool.borrow()` accepts any caller. Fix: add zkVerify attestation ID to borrow call and verify against aggregation contract.

### 5. Fix C-2: Liquidation does not unlock collateral
`liquidate()` never calls `ShieldedPool.unlockNullifier()`. Collateral note stays locked permanently after liquidation. (Note: C-2 will be auto-fixed in V2A+ sharding implementation which rewrites the liquidate() shard routing.)

### 6. Security hardening (before mainnet)
See `AUDIT_REPORT.md` for the full list of 27 documented findings. H-1 and H-3 fixed. Critical open items: C-1 (borrow access control), C-2 (liquidation collateral unlock).

---

## What Was Built in Each Session

### Session 1 — Initial V2A Build
- Defined V2A architecture: vault-strategy separation, ring proofs, epoch batching, single-leaf zkVerify aggregation
- Compiled `withdraw_ring.circom` (K=16, LEVELS=24) and `collateral_ring.circom`
- Deployed all 4 contracts to Base Sepolia
- Built frontend: Deposit, Withdraw (with flush flow), Borrow, Repay, History tabs
- Integrated zkVerify: single-leaf statementHash aggregation pattern

### Session 2 — End-to-End Integration (Bugs 1–18)
- Fixed 18 bugs across circuits, contracts, and frontend
- Confirmed: Deposit → flushEpoch → withdraw_ring proof → zkVerify attestation → `withdraw()` works end-to-end
- Fixed commitment formula in `collateral_ring.circom`: removed denomination from hash (Poseidon(2) not Poseidon(3))
- Fixed AES-256-GCM note encryption + HKDF key derivation from MetaMask wallet signature

### Session 3 — Repay UX + Borrow Prep (Bugs 19–21)
- Bug 19: Stale `totalOwed` → InsufficientRepayment revert — fixed by re-reading at click time + 0.1% buffer
- Bug 20: Repay section had stale undefined variable references + manual text input — replaced with auto-discovered loan dropdown
- Bug 21: History.tsx was appending `...` to loan#N entries — fixed conditional shortId display
- Complete doc rewrite: all 6 docs updated from V1 content to V2A architecture

### Session 4 — Security Fixes + H-1/H-3 Circuit Recompile
- H-1 (denomination not in commitment hash): `Poseidon(secret, nullifier, denomination)`, added `denomination_out` public signal
- H-3 (ring_index in nullifier hash enables cross-ring replay): `nullifierHash = Poseidon(nullifier)` only
- Epoch countdown double-0x bug fixed; cross-tab withdrawal progress banner added
- Third contract deployment to Base Sepolia after circuit recompile

### Session 5 (Planning) — V2A+ Complete Privacy Architecture
- Identified two remaining privacy leaks: deposit `tx.from` = user wallet; withdrawal recipient = user wallet
- Designed 5 new privacy features: stealth addresses (ERC-5564), deposit relay, viewing keys, encrypted notes, CREATE2 sharding
- Researched cross-shard withdrawal: NO circuit change required — same `vkHash` for all shards makes proofs fungible
- Global root registry pattern in LendingPool enables withdraw proof from ShardPool_X to be redeemed at ShardPool_Y
- Designed cross-shard borrow liquidity: `collateralShard` ≠ `disburseShard` prevents per-shard liquidity fragmentation
- Full implementation plan documented in `docs/privacy-architecture.md`
