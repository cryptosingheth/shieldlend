# ShieldLend V2A — Security Audit & Implementation Report

**Branch**: `v2a-architecture`
**Date**: 2026-04-03
**Auditor**: Internal (Claude Code, session 9e2ba90d)
**Scope**: All Solidity contracts, Circom circuits, and TypeScript frontend library code

---

## Table of Contents

1. [V1 → V2 Architectural Evolution](#1-v1--v2-architectural-evolution)
2. [What Was Implemented in This Session](#2-what-was-implemented-in-this-session)
3. [Development Approach](#3-development-approach)
4. [Audit Findings Summary](#4-audit-findings-summary)
5. [Critical Findings](#5-critical-findings)
6. [High Findings](#6-high-findings)
7. [Medium Findings](#7-medium-findings)
8. [Low Findings](#8-low-findings)
9. [Informational](#9-informational)
10. [Bugs Fixed During Development](#10-bugs-fixed-during-development)
11. [Fix Roadmap (Priority Order)](#11-fix-roadmap-priority-order)
12. [Deployment State](#12-deployment-state)

---

## 1. V1 → V2 Architectural Evolution

### V1 Summary

ShieldLend V1 used a Tornado Cash-style fixed-denomination shielded pool:

- Single commitment leaf per deposit (`Poseidon(secret, nullifier)`, 2 inputs)
- Merkle tree depth 20, no denomination binding
- On-chain Groth16 verifier (Solidity) — full calldata + gas cost
- All withdrawal nullifiers public on-chain
- No lending integration — pool was standalone
- No note encryption — user held secret/nullifier in plaintext
- No ring privacy — single-note withdraw proofs

### V2A Changes (this branch)

| Dimension | V1 | V2A |
|---|---|---|
| Proof verification | On-chain Groth16 Solidity verifier | Off-chain via zkVerify Volta + aggregation root |
| Ring size | 1 (single-note) | k=16 ring members |
| Merkle depth | 20 | 24 |
| Denominations | Free-form amount | Fixed: 0.01/0.1/1/10 ETH |
| Epoch batching | None | 3-epoch buffer + Fisher-Yates shuffle + adaptive dummy insertion |
| Note storage | Plaintext | AES-256-GCM, HKDF key from MetaMask wallet signature |
| Lending | None | LendingPool.sol — borrow/repay with collateral nullifier gating |
| Auto-settle | None | Withdraw atomically repays outstanding loans |
| Interest model | None | Aave v3 two-slope (R_BASE=1%, R_SLOPE1=4%, U_opt=80%, R_SLOPE2=40%) |
| Collateral proof | None | collateral_ring.circom — LTV check inside circuit |
| Stealth addresses | None | @scopelift/stealth-address-sdk added (not yet wired) |

---

## 2. What Was Implemented in This Session

### Phase 1 — Core V2 Contracts

**`contracts/src/ShieldedPool.sol`**
- Merkle tree expanded to depth 24 (16M leaf capacity)
- Fixed denomination enum: DENOM_001, DENOM_01, DENOM_1, DENOM_10
- Epoch-based batching: 256-block epochs, 10/5/2 adaptive dummy counts
- Fisher-Yates shuffle using `block.prevrandao` for ring ordering
- `auto-settle`: `withdraw()` checks LendingPool for active loan; if found, repays before releasing ETH
- `LeafInserted(uint32 index, bytes32 leaf)` event for frontend Merkle reconstruction
- zkVerify aggregation root verification replacing on-chain Groth16 verifier

**`contracts/src/LendingPool.sol`**
- `borrow(uint256 amount, bytes32 collateralNullifier)` — draws against shielded collateral
- `repay(bytes32 collateralNullifier)` — repays outstanding loan
- `liquidate(bytes32 collateralNullifier)` — liquidates undercollateralized positions
- Aave v3 two-slope interest accrual in `_accrueInterest()`
- `disburseLoan()` — ShieldedPool calls this during auto-settle to unblock collateral

**`contracts/src/NullifierRegistry.sol`**
- Tracks spent nullifiers globally (shared between ShieldedPool and LendingPool)
- `isSpent(bytes32)` — external view, used by both contracts
- `setShieldedPool(address)` — admin setter (see C-3 / N-7 in audit)

**`contracts/script/Deploy.s.sol`**
- Deploys NullifierRegistry → ShieldedPool → LendingPool in correct dependency order
- Wires LendingPool address into ShieldedPool post-deploy
- Accepts `WITHDRAW_RING_VK_HASH` from environment for zkVerify registration

### Phase 2 — Circom Circuits

**`circuits/withdraw_ring.circom`** — `WithdrawRing(LEVELS=24, K=16)`
- Inputs: `secret`, `nullifier`, `ring[16]`, `ring_index`, `pathElements[24]`, `pathIndices[24]`, `root`, `recipient`, `relayer`, `fee`
- Commitment: `Poseidon(secret, nullifier)` — 2 inputs
- NullifierHash: `Poseidon(nullifier, ring_index)`
- Ring membership: one-hot selector, inner product, equality check
- Global inclusion: MerkleTreeChecker(24)

**`circuits/collateral_ring.circom`** — `CollateralRing(LEVELS=24, K=16)`
- Adds `denomination`, `borrowed`, `minRatioBps` inputs
- Commitment: `Poseidon(secret, nullifier, denomination)` — 3 inputs
- LTV guard: `denomination * minRatioBps >= borrowed * 10000` via GreaterEqThan(96)

**`circuits/scripts/trusted_setup.sh`**
- Automates Powers of Tau (2^17 from Google Cloud Storage / iden3 zkEVM bucket)
- Per-circuit Phase 2 zkey generation + randomness contribution
- VK JSON export + Solidity verifier export (informational only — V2 uses zkVerify)
- On-chain VK hash computation via ethers.keccak256

### Phase 3 — Frontend

**`frontend/src/lib/noteStorage.ts`** — AES-256-GCM encrypted note persistence
- `encryptNote(note, key)` / `decryptNote(ciphertext, key)` with 12-byte random IV
- `saveNote(address, note, key, txHash)` — stores encrypted ciphertext in localStorage
- `loadNotes(address, key)` — decrypts all notes for connected wallet

**`frontend/src/lib/noteKeyContext.tsx`** — React context for session encryption key
- `NoteKeyProvider`: prompts MetaMask for deterministic signature over fixed message
- `HKDF(SHA-256, sig_bytes, salt="ShieldLend-note-key", info="note-encryption")` → 32-byte AES key
- Key is held in React state only — never persisted, derived fresh each session

**`frontend/src/components/DepositForm.tsx`** — wired to encrypted note storage
**`frontend/src/app/providers.tsx`** — NoteKeyProvider wraps entire app tree

---

## 3. Development Approach

### Toolchain

- **Circuits**: Circom 2.x, snarkjs 0.7.x, BabyJubJub/BN128 curve, Poseidon hash
- **Contracts**: Foundry (forge 0.2.x), Solidity 0.8.24, OpenZeppelin 5.x
- **Frontend**: Next.js 14, wagmi v2, viem v2, TanStack Query v5, Tailwind CSS
- **ZK verification**: zkVerify Volta testnet (off-chain Groth16, aggregation root posted on-chain)
- **Network**: Base Sepolia (chain ID 84532)

### Branch Strategy

`main` → `v2-architecture` (docs/spec only) and `v2a-architecture` (full implementation).
All implementation commits land on `v2a-architecture`. No merge to `main` until audit findings are resolved.

### Commit Sequence (this session)

```
11c4acb  feat: V2 contracts, circuits, and tests — ShieldLend V2A architecture
56417af  feat: implement V2 Phase 2 + Phase 3 — ring circuits, encrypted storage, V2 frontend
80f0fd5  fix: patch 3 critical/high bugs found during V2A security audit
7f7033f  feat: complete V2 implementation — README, NoteKeyProvider wiring, DepositForm encryption
```

### Testing Approach

- Forge unit tests in `contracts/test/` covering deposit, withdraw, borrow, repay, liquidate
- zkVerify integration tested on Volta testnet with live proof submission
- Frontend opened manually on `localhost:3000` to verify UI renders without errors
- Full end-to-end flow (deposit → withdraw with proof) **NOT yet tested** — blocked by audit findings below

---

## 4. Audit Findings Summary

| ID | Severity | Title | File | Status |
|---|---|---|---|---|
| C-1 | CRITICAL | `borrow()` has no access control | `LendingPool.sol:113` | Open |
| C-2 | CRITICAL | `liquidate()` never unlocks collateral | `LendingPool.sol:209` | Open |
| C-3 | CRITICAL | Commitment scheme mismatch across all three layers | Multiple files | Open |
| C-4 | CRITICAL | `circuits.ts` uses V1 circuit paths and V1 input structure | `circuits.ts:1-120` | Open |
| H-1 | HIGH | Withdraw amount not validated against denomination | `ShieldedPool.sol:withdraw()` | Open |
| H-2 | HIGH | `disburseLoan()` has no maximum amount cap | `LendingPool.sol:disburseLoan()` | Open |
| H-3 | HIGH | Ring-index-dependent nullifier enables double-spend | `withdraw_ring.circom:nullifierHash` | Open |
| H-4 | HIGH | `generateWithdrawProof` uses V1 input structure | `circuits.ts:generateWithdrawProof` | Open |
| H-5 | HIGH | `generateCollateralProof` uses V1 input structure | `circuits.ts:generateCollateralProof` | Open |
| H-6 | HIGH | `computeCommitment` input order wrong | `circuits.ts:computeCommitment` | Open |
| H-7 | HIGH | Missing env vars block all zkVerify submissions | `api/zkverify/route.ts` | Open |
| M-1 | MEDIUM | Repaid ETH trapped in LendingPool | `LendingPool.sol:repay()` | Open |
| M-2 | MEDIUM | Interest accrual uses block.timestamp — manipulable | `LendingPool.sol:_accrueInterest()` | Open |
| M-3 | MEDIUM | No slippage/deadline on borrow amount | `LendingPool.sol:borrow()` | Open |
| M-4 | MEDIUM | ShieldedPool.withdraw() re-entrancy window | `ShieldedPool.sol:withdraw()` | Open |
| M-5 | MEDIUM | `_dummiesForEpoch` reads block.number at proof time | `ShieldedPool.sol:_dummiesForEpoch()` | Open |
| M-6 | MEDIUM | Aggregation root staleness — no max age check | `ShieldedPool.sol:verifyProof()` | Open |
| M-7 | MEDIUM | `NullifierRegistry.setShieldedPool()` owner can rug | `NullifierRegistry.sol:45` | Open |
| L-1 | LOW | `ring[]` public input leaks ring composition | `withdraw_ring.circom` | Acknowledged |
| L-2 | LOW | Unused `relayer`/`fee` public inputs never validated | `withdraw_ring.circom` | Acknowledged |
| L-3 | LOW | `GreaterEqThan(96)` LTV check truncates at 96 bits | `collateral_ring.circom` | Open |
| L-4 | LOW | NoteKeyContext key not zeroized on unmount | `noteKeyContext.tsx` | Open |
| L-5 | LOW | `package-lock.json` not in `.gitignore` | `frontend/` | Open |

**Total: 4 Critical, 7 High, 7 Medium, 5 Low**

---

## 5. Critical Findings

### C-1 — `LendingPool.borrow()` Has No Access Control

**File**: `contracts/src/LendingPool.sol:113`
**Severity**: CRITICAL
**Impact**: Anyone can drain the ShieldedPool's ETH balance with a fabricated collateral nullifier.

**Description**: `borrow(uint256 amount, bytes32 collateralNullifier)` is `external` with no proof gate and no check that `collateralNullifier` was registered through a valid zkVerify-verified `collateralDeposit()` call. An attacker calls `borrow()` with a random `collateralNullifier` and an arbitrary `amount`, passes the `NullifierRegistry.isSpent()` check (nullifier is fresh), and receives ETH from ShieldedPool.

**Proof of concept**:
```solidity
// Attacker contract
function drain(ILendingPool pool, IShieldedPool sp) external {
    bytes32 fakeNullifier = keccak256("fake");
    pool.borrow(sp.balance(), fakeNullifier); // succeeds — no proof required
}
```

**Required fix**: Gate `borrow()` on a zkVerify-verified collateral proof. Either require the collateral nullifier to be pre-registered via `collateralDeposit()` (which does verify a proof), or add an on-chain mapping of `verifiedCollaterals[nullifier] = denomination` that is set only after proof verification.

---

### C-2 — `LendingPool.liquidate()` Never Unlocks Collateral

**File**: `contracts/src/LendingPool.sol:209`
**Severity**: CRITICAL
**Impact**: Liquidators pay off debt but collateral is permanently locked in the pool. Liquidation is economically irrational — no one will call it. Bad debt accumulates without resolution.

**Description**: `liquidate()` marks the loan as repaid (`loans[nullifier].active = false`) but never calls `ShieldedPool.releaseCollateral()` or any equivalent function. The collateral note is marked spent (nullifier registered) but the ETH is never returned to the liquidator.

**Required fix**: After marking the loan inactive, call `shieldedPool.releaseCollateral(collateralNullifier, msg.sender)` to transfer the collateral ETH to the liquidator (less a protocol fee).

---

### C-3 — Commitment Scheme Mismatch Across All Three Layers

**Files**: `circuits/withdraw_ring.circom`, `circuits/collateral_ring.circom`, `frontend/src/lib/circuits.ts`
**Severity**: CRITICAL
**Impact**: No deposited note can ever produce a valid proof in either circuit. The entire protocol is non-functional end-to-end.

**Description**: Three different Poseidon input orderings are used:

| Layer | Formula | Inputs |
|---|---|---|
| `withdraw_ring.circom` commitment | `Poseidon(secret, nullifier)` | 2 |
| `collateral_ring.circom` commitment | `Poseidon(secret, nullifier, denomination)` | 3 |
| `circuits.ts computeCommitment` | `Poseidon(nullifier, secret, amount)` | 3, different order |

A commitment computed by the frontend (`Poseidon(nullifier, secret, amount)`) will never match what the withdraw circuit expects (`Poseidon(secret, nullifier)`) or what the collateral circuit expects (`Poseidon(secret, nullifier, denomination)`).

**Required fix**: Agree on a single canonical formula (recommend `Poseidon(secret, nullifier, denomination)` — denomination-binding is important for collateral), use it in all three files, and re-run trusted setup after any circuit change.

---

### C-4 — `circuits.ts` Uses V1 Circuit Paths and V1 Input Structure

**File**: `frontend/src/lib/circuits.ts`
**Severity**: CRITICAL
**Impact**: Every `generateWithdrawProof()` and `generateCollateralProof()` call will fail with "file not found" because the V2 wasm/zkey files have different names and paths.

**Description**:
- Line ~12: `wasmPath: '/circuits/withdraw.wasm'` — V1 name. V2 file is `withdraw_ring.wasm`.
- Line ~13: `zkeyPath: '/circuits/withdraw.zkey'` — V1 name. V2 file is `withdraw_ring.zkey`.
- `generateWithdrawProof` input object: `{ root, nullifierHash, recipient, relayer, fee, pathElements, pathIndices }` — V1 structure, missing `ring[]` and `ring_index`.
- `generateCollateralProof` input object: `{ collateral, borrowed, ratio }` — V1 structure, missing ring inputs, Merkle path, denomination.

**Required fix**: Complete rewrite of `circuits.ts` to match V2 circuit interfaces. See fix roadmap below for the full required input structure.

---

## 6. High Findings

### H-1 — Withdraw Amount Not Validated Against Denomination

**File**: `contracts/src/ShieldedPool.sol:withdraw()`
**Severity**: HIGH
**Impact**: Attacker withdraws a large denomination note but only pays back a small fraction of the loan.

**Description**: `withdraw()` accepts a `uint256 amount` parameter and transfers it to the recipient. The circuit proves a note of fixed denomination exists in the tree, but the contract does not check that `amount == denomination`. A prover can set `amount = 0.001 ETH` while the note is `1 ETH`.

**Required fix**: Add `require(amount == denominationAmounts[proof.denomination], "amount != denomination")` in `withdraw()`. Or: remove the `amount` parameter entirely — always pay out `denomination`.

---

### H-2 — `disburseLoan()` Has No Maximum Amount Cap

**File**: `contracts/src/LendingPool.sol:disburseLoan()`
**Severity**: HIGH
**Impact**: If `disburseLoan()` is called by a compromised ShieldedPool (or due to C-1 above), it can drain the entire pool balance.

**Description**: `disburseLoan(address recipient, uint256 amount)` sends `amount` ETH to `recipient` with no upper bound. There is no check that `amount <= loans[nullifier].principal` or any per-call cap.

**Required fix**: Add `require(amount <= maxBorrowPerNote[denomination], "exceeds max")` and validate that the call originates from a whitelisted ShieldedPool instance.

---

### H-3 — Ring-Index-Dependent Nullifier Enables Double-Spend

**File**: `circuits/withdraw_ring.circom:nullifierHash`
**Severity**: HIGH
**Impact**: The same secret note can be spent once in ring A (at index 3) and again in ring B (at index 7), because the two nullifier hashes are different.

**Description**: `nullifierHash = Poseidon(nullifier, ring_index)`. The nullifier is not a fixed function of the note alone — it varies with the ring configuration. On-chain, each unique `nullifierHash` is treated as a unique spend. A well-crafted relayer could arrange two different rings containing the same note at different indices, allowing double-spend.

**Recommended fix (option 1 — safest)**: Use `nullifierHash = Poseidon(nullifier)` — independent of ring membership. The ring membership constraint stays in the circuit but doesn't affect the spend tag.

**Recommended fix (option 2)**: Use `nullifierHash = Poseidon(nullifier, merkle_root)` — ties the spend to a specific tree state, preventing reuse across tree checkpoints.

---

### H-4 — `generateWithdrawProof` Passes V1 Input Structure

**File**: `frontend/src/lib/circuits.ts:generateWithdrawProof`
**Severity**: HIGH
**Impact**: Every withdraw proof generation call fails at snarkjs runtime.

**Required V2 input structure**:
```typescript
{
  secret,
  nullifier,
  ring: [16 leaf values],      // ring members
  ring_index,                  // prover's position in ring (0-15)
  pathElements: [24 values],   // Merkle auth path
  pathIndices: [24 values],    // 0=left, 1=right per level
  root,
  recipient,
  relayer,
  fee
}
```

---

### H-5 — `generateCollateralProof` Passes V1 Input Structure

**File**: `frontend/src/lib/circuits.ts:generateCollateralProof`
**Severity**: HIGH
**Impact**: Every collateral proof generation call fails at snarkjs runtime.

**Required V2 input structure**:
```typescript
{
  secret,
  nullifier,
  denomination,
  borrowed,
  minRatioBps,
  ring: [16 leaf values],
  ring_index,
  pathElements: [24 values],
  pathIndices: [24 values],
  root
}
```

---

### H-6 — `computeCommitment` Uses Wrong Input Order

**File**: `frontend/src/lib/circuits.ts:computeCommitment`
**Severity**: HIGH
**Impact**: All commitments deposited via the frontend will fail to match the circuit's expected commitment, making all notes unspendable.

**Current**: `poseidon([nullifier, secret, amount])`
**Required** (to match collateral_ring.circom): `poseidon([secret, nullifier, denomination])`

Note: if C-3 is resolved by choosing `Poseidon(secret, nullifier)` for withdraw, then `computeCommitment` must produce different values for the two circuit types, or a single canonical 3-input form must be adopted.

---

### H-7 — Missing Env Vars Block All zkVerify Proof Submissions

**File**: `frontend/src/app/api/zkverify/route.ts`
**Severity**: HIGH
**Impact**: Every withdrawal attempt fails with "aggregation root not found" or similar, because the zkVerify relay never posts the root on-chain.

**Missing variables (not in `.env.local` or docs)**:
- `DEPLOYER_PRIVATE_KEY` — used to sign the aggregation root posting transaction
- `ZKVERIFY_AGGREGATION_ADDRESS` — the zkVerify Volta contract address on Base Sepolia

**Required fix**: Add these to `.env.local.example`, document them in README, and confirm the values match the live Volta deployment.

---

## 7. Medium Findings

### M-1 — Repaid ETH Trapped in LendingPool

**File**: `contracts/src/LendingPool.sol:repay()`
**Impact**: ETH sent to `repay()` stays in the LendingPool contract. There is no mechanism to return excess repayment or route repaid principal back to the ShieldedPool's liquidity buffer.

---

### M-2 — Interest Accrual Uses `block.timestamp` — Manipulable by Proposers

**File**: `contracts/src/LendingPool.sol:_accrueInterest()`
**Impact**: On Base (optimistic rollup), L2 block timestamps are controlled by the sequencer and can be set arbitrarily within a window. A colluding proposer can manipulate `delta` to accrue more or less interest.

---

### M-3 — No Slippage or Deadline on Borrow Amount

**File**: `contracts/src/LendingPool.sol:borrow()`
**Impact**: A borrower submitting a transaction can have their borrow executed at a different rate than expected if interest accrues between submission and inclusion.

---

### M-4 — `ShieldedPool.withdraw()` Re-Entrancy Window

**File**: `contracts/src/ShieldedPool.sol:withdraw()`
**Impact**: ETH is transferred to `recipient` before the auto-settle callback to LendingPool completes. A malicious `recipient` contract could re-enter `withdraw()` before the nullifier is fully registered.

**Recommended fix**: Follow checks-effects-interactions. Register the nullifier first, then call auto-settle, then transfer ETH.

---

### M-5 — `_dummiesForEpoch` Reads `block.number` at Proof Time, Not at Epoch Start

**File**: `contracts/src/ShieldedPool.sol:_dummiesForEpoch()`
**Impact**: The dummy count can vary between when a user generates their proof and when the transaction is included, if the epoch boundary is crossed during mempool wait time.

---

### M-6 — Aggregation Root Staleness — No Maximum Age Check

**File**: `contracts/src/ShieldedPool.sol:verifyProof()`
**Impact**: An old aggregation root (from a week ago) can be reused to verify a proof. No `rootTimestamp` or `maxRootAge` guard exists.

---

### M-7 — `NullifierRegistry.setShieldedPool()` Allows Owner to Point Registry at Malicious Pool

**File**: `contracts/src/NullifierRegistry.sol:45`
**Impact**: Owner can redirect the registry to a new ShieldedPool that treats all previously spent nullifiers as fresh, enabling double-spend for the owner. Should be a one-time immutable setter or governed by a timelock.

---

## 8. Low Findings

### L-1 — `ring[]` Public Input Leaks Ring Composition

**File**: `circuits/withdraw_ring.circom`
**Impact**: All 16 ring member commitments are public inputs. An on-chain observer can reconstruct which 16 leaves were chosen as the ring, reducing the anonymity set to 16 known candidates even if the prover's identity within the ring is hidden.

**Note**: This is a known trade-off of ring signatures on public blockchains. Tornado Cash avoids it by not using rings. Mitigation: use a Merkle root over the ring rather than enumerating all members as public inputs.

---

### L-2 — Unused `relayer` and `fee` Public Inputs Never Validated

**File**: `circuits/withdraw_ring.circom`
**Impact**: The circuit constrains these values as public inputs (preventing tampering after proof generation) but the Solidity contract never checks them. A relayer can substitute their own address without invalidating the proof.

---

### L-3 — `GreaterEqThan(96)` LTV Check Truncates at 96 Bits

**File**: `circuits/collateral_ring.circom`
**Impact**: `denomination * minRatioBps` and `borrowed * 10000` are each up to ~128 bits for 10 ETH denominations. If either operand exceeds 96 bits, `GreaterEqThan(96)` silently truncates and the comparison is wrong. Use `GreaterEqThan(128)` to be safe.

---

### L-4 — NoteKeyContext AES Key Not Zeroized on Unmount

**File**: `frontend/src/lib/noteKeyContext.tsx`
**Impact**: The 32-byte AES key stays in React state until garbage collected. If the browser tab is closed, the key remains in memory until GC. Low practical impact on modern browsers with process isolation, but not best practice for key material.

---

### L-5 — `package-lock.json` Not in `.gitignore`

**File**: `frontend/package-lock.json`
**Impact**: Large auto-generated file was staged as an untracked file. This bloats diffs and causes noisy PR reviews. Add `frontend/package-lock.json` to `.gitignore` (or commit it consistently — pick one).

---

## 9. Informational

### N-1 — ERC-5564 Stealth Address SDK Added but Not Wired

`@scopelift/stealth-address-sdk` is in `package.json` but no component calls it. The intent (per V2 spec) is to derive a fresh stealth address per deposit so the recipient address is not reused. This is the correct design but is not yet implemented.

### N-2 — `trusted_setup.sh` Uses Fixed Entropy String for Ceremony Contribution

The script passes `"ShieldLend-withdraw-ring-contribution-$(date +%s)"` as the ceremony randomness. This is deterministic (given timestamp) and not safe for production trusted setup. For mainnet, replace with an interactive multi-party ceremony contribution or at minimum use `/dev/urandom`.

### N-3 — VK Hash Computation Uses Sorted JSON Keys

The keccak256 VK hash is computed over `JSON.stringify(vkey, Object.keys(vkey).sort())`. This is deterministic but fragile — if snarkjs ever changes the key naming or structure, the hash changes. Consider hashing the individual curve points directly instead.

### N-4 — `block.prevrandao` Is Not a Secure Randomness Source for Ring Shuffles

`block.prevrandao` (formerly `DIFFICULTY`) on Base L2 is set by the sequencer and can be influenced. For the purpose of shuffling dummies into epochs, this is acceptable (adversary gains marginal benefit from knowing shuffle order). For any security-critical randomness, use a VRF or commit-reveal scheme.

### N-5 — No Events on LendingPool State Changes

`borrow()`, `repay()`, and `liquidate()` emit no events. This makes it impossible to reconstruct loan state from logs alone. Add `Borrow`, `Repay`, and `Liquidate` events.

### N-6 — No Pause Mechanism

Neither ShieldedPool nor LendingPool has a `pause()` function. In the event of a discovered vulnerability (like C-1), there is no way to halt new deposits or borrows without deploying a new contract.

### N-7 — `NullifierRegistry.setShieldedPool()` — see M-7 above (also informational upgrade path note)

Consider using OpenZeppelin `Ownable2Step` for the admin transfer pattern and adding a timelock before any address change takes effect.

---

## 10. Bugs Fixed During Development

Three bugs were found and fixed in commit `80f0fd5` before the final audit pass:

### Bug 1 — Auto-Settle Proof Bypass (CRITICAL — FIXED)

**Location**: Original `ShieldedPool.sol:withdraw()`
**Description**: The auto-settle call to `lendingPool.disburseLoan()` happened BEFORE `require(proofVerified)`. An attacker could trigger auto-settle (clearing their loan) without providing a valid proof, simply by calling `withdraw()` with junk proof data.
**Fix**: Moved `require(proofVerified)` check to before the auto-settle callback.

### Bug 2 — Wrong Merkle Leaf Index (HIGH — FIXED)

**Location**: Original `ShieldedPool.sol:_insertLeaf()`
**Description**: New leaves were inserted at `nextIndex` but the event emitted `nextIndex + 1`. The frontend was building a Merkle tree with all leaf positions off by one, making every withdrawal proof fail with "root mismatch".
**Fix**: Emit `LeafInserted(nextIndex, leaf)` before incrementing `nextIndex`.

### Bug 3 — `_dummiesForEpoch` Integer Underflow (HIGH — FIXED)

**Location**: Original `ShieldedPool.sol:_dummiesForEpoch()`
**Description**: `uint8 depositsThisEpoch = depositCount[epoch]`. If `depositCount[epoch]` was 0, the branch `depositsThisEpoch < 5` evaluated correctly, but a subsequent subtraction `depositsThisEpoch - 1` underflowed to 255 and returned 10 dummies for every single deposit, DoS-ing the epoch buffer.
**Fix**: Added explicit `if (depositsThisEpoch == 0) return 10;` guard at top of function.

---

## 11. Fix Roadmap (Priority Order)

### Tier 1 — Must Fix Before Any User Deposits

1. **C-3 + C-4 + H-4 + H-5 + H-6**: Unify commitment scheme and rewrite `circuits.ts`
   - Decide canonical Poseidon formula (recommend `Poseidon(secret, nullifier, denomination)`)
   - Update `withdraw_ring.circom` commitment line
   - Update `circuits.ts:computeCommitment`, `generateWithdrawProof`, `generateCollateralProof`
   - Re-run trusted setup (zkey invalidated by circuit change)

2. **C-1**: Gate `borrow()` on verified collateral
   - Add `mapping(bytes32 => uint256) public verifiedCollaterals` to LendingPool
   - Set `verifiedCollaterals[nullifier] = denomination` only from `collateralDeposit()` (which verifies zkVerify proof)
   - In `borrow()`: `require(verifiedCollaterals[collateralNullifier] > 0, "no verified collateral")`

3. **H-7**: Document and verify missing env vars
   - Add `DEPLOYER_PRIVATE_KEY` and `ZKVERIFY_AGGREGATION_ADDRESS` to `.env.local.example`
   - Confirm values from zkVerify Volta documentation

### Tier 2 — Fix Before Mainnet

4. **C-2**: Fix `liquidate()` collateral release
5. **H-1**: Validate withdraw amount == denomination
6. **H-2**: Cap `disburseLoan()` amount
7. **H-3**: Use ring-index-independent nullifier
8. **M-1**: Route repaid ETH back to ShieldedPool liquidity
9. **M-4**: Fix re-entrancy order in `withdraw()`
10. **M-7**: Add timelock to `setShieldedPool()`

### Tier 3 — Hardening

11. **M-2**: Document timestamp manipulation risk; consider block-based time
12. **M-3**: Add deadline parameter to `borrow()`
13. **M-6**: Add `maxRootAge` to proof verification
14. **L-3**: Increase `GreaterEqThan` to 128 bits
15. **N-1**: Wire ERC-5564 stealth address derivation in DepositForm
16. **N-2**: Replace fixed-entropy ceremony contribution before any mainnet deployment
17. **N-5**: Add events to LendingPool
18. **N-6**: Add pause mechanism

---

## 12. Deployment State

### Base Sepolia (chain ID 84532) — Live as of 2026-03-28

| Contract | Address |
|---|---|
| ShieldedPool | `0xef7c8E84cb8e2C624Ff34e19E02b1b4c32A769Cd` |
| LendingPool | `0x9e927D66b32D626248E8Ddf877C749c5c44Cdf68` |
| NullifierRegistry | `0x626E86be2AB875F175F3461aAA9DE1F1Ba145E96` |

**Status**: Deployed. **Do not point users at these addresses until Tier 1 fixes are applied and circuits.ts is rewritten.** The C-1 vulnerability means any user funds deposited could be extracted by an attacker calling `borrow()` directly.

### zkVerify

**VK hash in `.env`**: `0x3c7529ffc44c852ad3b1b566a976ea29f379eec2a2edadb7ade311a432962e49`
**Note**: This VK hash was computed from the trusted setup output. It becomes invalid if any circuit constraint changes (i.e., after fixing C-3). A new trusted setup must be run and the new hash re-deployed.

---

*Report generated from audit session 9e2ba90d on branch v2a-architecture. All findings are open unless marked FIXED.*
