# ShieldLend — Project Roadmap

This document tracks what has been built and what remains. The V2A architecture is fully deployed on Base Sepolia.

---

## V2A Status — Base Sepolia (Chain ID 84532)

| Phase | Status |
|-------|--------|
| Circuits: `withdraw_ring.circom`, `collateral_ring.circom` | ✅ Compiled, trusted setup done |
| Contracts: ShieldedPool, LendingPool, NullifierRegistry, ZkVerifyAggregation | ✅ Deployed |
| Frontend: Deposit, Withdraw, Borrow, Repay, History | ✅ Built |
| zkVerify integration (Volta testnet) | ✅ Integrated |
| End-to-end: Deposit → Withdraw | ✅ Confirmed live |
| End-to-end: Borrow → Repay | 🔜 Pending live test |
| Security: Access control on borrow (C-1) | ⚠️ Open critical finding |
| Production chain: Horizen L3 deploy | ⏳ Future |

---

## Deployed Contracts — Base Sepolia

| Contract | Address |
|----------|---------|
| ShieldedPool | `0xfaeD6bf64a513aCEC9E8f1672d5e6584F869661a` |
| LendingPool | `0xdBc459EC670deE0ae70cbF8b9Ea43a00b7A9184D` |
| NullifierRegistry | `0x685E69Fa36521f527C00E05cf3e18eE4d18aD10C` |
| ZkVerifyAggregation | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` |

---

## Next Steps

### 1. Live-test borrow flow
- Select a flushed note → enter borrow amount → ZK proof (~25s) → zkVerify → `borrow()` tx
- Confirm `Borrowed(loanId)` event in History

### 2. Live-test repay flow
- Select loan from dropdown → click Repay → confirm `Repaid(loanId, totalRepaid)` event

### 3. Fix C-1: Borrow access control (before any public demo)
`LendingPool.borrow()` currently accepts any caller with any collateral nullifier hash — no on-chain ZK proof verification gate. Suitable for hackathon only.

Options:
- Add an `onlyShieldedPool` guard and route borrow calls through ShieldedPool (which has the aggregation root)
- Or: store the zkVerify attestation ID in the borrow call and verify it against the aggregation contract

### 4. Fix C-2: Liquidation does not unlock collateral
`liquidate()` marks `loan.repaid = true` and removes the active loan record, but never calls `ShieldedPool.unlockNullifier()`. The collateral note stays locked permanently after liquidation.

### 5. Production chain: Horizen L3
When Horizen L3 testnet is available:
- Redeploy all contracts to Horizen L3
- Update `.env.local` with new RPC + contract addresses
- Verify zkVerify domain ID for Horizen L3
- Update History.tsx deploy block number

### 6. Security hardening (before mainnet)
See `AUDIT_REPORT.md` for the full list of 21 documented findings. Critical open items: C-1 (borrow access control), C-2 (liquidation collateral unlock), H-1 through H-3. These are documented as acceptable for hackathon/testnet use only.

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
