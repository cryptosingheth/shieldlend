# Session 7 — 2026-04-10/11 — V2B Cross-Shard Withdrawal

**Branch**: `v2a-architecture`  
**Commits**: `964bd55`, `d59a046`, `10af825`, `416765d`, `8f98b05`

## Problem Identified

V2A privacy gap: deposits and withdrawals both routed to the same shard. Observer could correlate:
- `ShardPool_2` deposit event ↔ `ShardPool_2` withdrawal event via shared shard address
- User wallet absent from both (Feature B relay), but shard address acts as a link

## What Changed

### Smart Contracts

**`ShieldedPool.sol` — `withdraw()` cross-shard auto-settle fix**  
Replaced per-shard `lockedAsCollateral[nullifierHash]` check with global `ILendingPool.hasActiveLoan()`.  
Per-shard flag is only set on the deposit shard; withdrawal shard's flag is always `false` — without this fix, auto-settlement silently skipped loan repayment in V2B.

```solidity
// V2A (broken for cross-shard):
if (lockedAsCollateral[nullifierHash]) { ... }

// V2B (global check):
bool globallyLocked = lendingPool != address(0) &&
    ILendingPool(lendingPool).hasActiveLoan(nullifierHash);
```

**`LendingPool.sol` — `settleCollateral()` cross-shard settlement**  
Removed `require(msg.sender == loan.collateralShard)`. Added explicit `IShieldedPool(collateralShard).unlockNullifier()` call so nullifier is always unlocked on the correct shard regardless of which shard calls `settleCollateral`.

**`ILendingPool` interface** — added `hasActiveLoan(bytes32) external view returns (bool)`

**Test mocks** — added `hasActiveLoan()` returning `owedAmount > 0` to `MockLendingPool` and `MockLP`

### Frontend

**`WithdrawForm.tsx` — cross-shard routing (V2B core)**  
- `getAllLogsAllShards()` — 5 parallel getLogs calls across all shards to find commitment
- `findShardForCommitment()` — identifies depositShard from log scan
- After finding depositShard, picks random `withdrawalShard ≠ depositShard` with sufficient ETH balance
- All shard-specific calls (getLastRoot, withdraw tx, flush) use correct shard addresses

**`DepositForm.tsx` — binary note packing (Feature D fix)**  
JSON-serialized notes were ~418 bytes, exceeding the 256B ShieldedPool cap. Binary pack:
- `nullifier (32B) || secret (32B) || amount (8B)` = 72B plaintext → 100B AES-GCM output

**`contracts.ts`** — added `ALL_SHARD_ADDRESSES` export for multi-shard scanning

**`BorrowForm.tsx` + `WithdrawForm.tsx`** — `DEPLOY_BLOCK` updated to `40034191n` (V2B deploy block)

### Live Test Suite (`live-test.mjs`)
- Updated to V2B addresses (all 5 shards, LendingPool, NullifierRegistry)
- T7 fix: replaced `getLogs` (rejected by public Base Sepolia RPC) with receipt-based log parsing
- 32/32 passing

### Deploy Script
- `contracts/script/DeployV2B.s.sol` — uses salt `bytes32(i + 200)` to avoid CREATE2 collision with V2A

### Documentation
- `ARCHITECTURE_DECISIONS.md` — 25 ADRs covering all design decisions V1 through V2B
- `CLAUDE.md` (project-level) — standing instruction for auto-ADR updates in future sessions
- `AUDIT_REPORT.md` — Section 14 appended with V2B bugs
- `SESSION_LOGS/` — this directory created; backfilled session logs for sessions 1–7
- `STATUS_REPORT.md` — deleted (replaced by this session log pattern)

## Bugs Fixed This Session
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| V2B-01 | HIGH | Cross-shard auto-settle skipped loan repayment | Global `hasActiveLoan()` check |
| V2B-02 | HIGH | `settleCollateral()` blocked cross-shard callers | Removed same-shard restriction, explicit `unlockNullifier()` |
| V2B-03 | MEDIUM | WithdrawForm only scanned Shard 1 | `getAllLogsAllShards()` scans all 5 |
| V2B-04 | MEDIUM | JSON note exceeded 256B cap — deposit reverted | Binary packing: 72B → 100B |
| V2B-05 | LOW | `getLogs` rejected by public RPC — T7 always failed | Receipt-based log parsing |

## Deployed Contracts — Base Sepolia — V2B (2026-04-10, block 40034191)

| Contract | Address |
|----------|---------|
| NullifierRegistry V2B | `0xEBC14761D4A2E30771E422F52677ed17896ec21F` |
| LendingPool V2B | `0xA1d0F1A35F547698031F14fE984981632AC26240` |
| Shard 1 | `0xcF78eaEA131747c67BBD1869130f0710bA646D8D` |
| Shard 2 | `0x3110C104542745c55cCA31A63839F418d1354F5D` |
| Shard 3 | `0x39769faD54c21d3D8163D9f24F63473eCC528bE0` |
| Shard 4 | `0x02dfe4aed5Ba2A2085c80F8Fe7c20686d047111B` |
| Shard 5 | `0xf3F7C4c1a352371eC3ae7e70387c259c7051b348` |

**VK Hash**: `0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572` (unchanged)

## Test Suite
86/86 forge tests passing | 32/32 live tests passing

## Cumulative Project Stats
| Metric | Value |
|--------|-------|
| Total sessions | 7 |
| Total bugs found | 48 |
| Total bugs fixed | 46 |
| Open (accepted) | 2 |
| Contracts deployed | 4 times (Session 1, 4, 6, 7) |
| Live on-chain tests | 32/32 |
