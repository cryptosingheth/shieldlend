# Session 1 — 2026-04-03 — V2A Initial Build

**Branch**: `v2a-architecture`  
**Commits**: `11c4acb`, `56417af`, `80f0fd5`, `7f7033f`

## What Was Built

### Contracts
- `ShieldedPool.sol` — Merkle depth 24, fixed denominations, epoch batching (256 blocks), Fisher-Yates shuffle, adaptive dummy insertion, zkVerify aggregation root verification, auto-settle on withdrawal
- `LendingPool.sol` — borrow/repay/liquidate with collateral nullifier gating, Aave v3 two-slope interest model
- `NullifierRegistry.sol` — shared nullifier tracking
- `ZkVerifyAggregation.sol` — on-chain aggregation root registry

### Circuits
- `withdraw_ring.circom` — K=16 ring proof, depth-24 Merkle inclusion, Poseidon commitment
- `collateral_ring.circom` — K=16 ring proof with LTV guard, no nullifier-spend (collateral stays live)

### Frontend
- `noteStorage.ts` — AES-256-GCM note encryption with HKDF key from MetaMask signature
- `noteKeyContext.tsx` — React context for session note key
- `DepositForm.tsx`, `BorrowForm.tsx`, `WithdrawForm.tsx` wired

## Bugs Found & Fixed (Session 1 Audit)
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| C-1 | CRITICAL | `borrow()` had no access control — anyone could drain ETH | Added `onlyOperator` gate |
| C-2 | CRITICAL | `liquidate()` never unlocked collateral — bad debt permanent | Added `releaseCollateral()` call |
| C-3 | CRITICAL | Commitment scheme mismatch across circuit/contract/frontend | Aligned all to `Poseidon(secret, nullifier, denomination)` |
| C-4 | CRITICAL | Frontend used V1 circuit paths and input structure | Rebuilt `circuits.ts` for V2A inputs |
| H-1 | HIGH | Withdraw amount not validated against denomination | Added denomination cap check |
| H-2 | HIGH | `disburseLoan()` had no max cap | Added `collateralAmount` bound |
| H-3 | HIGH | Ring-index-dependent nullifier enabled double-spend | Fixed nullifierHash to `Poseidon(nullifier)` only |
| H-4–H-7 | HIGH | Multiple frontend proof input/env bugs | Fixed in `circuits.ts` + `api/zkverify` |

## Deployed Contracts (initial — later superseded)
Not recorded (first deploy, replaced by Session 4 redeploy)

## Test Suite
First passing forge test suite — exact count not recorded
