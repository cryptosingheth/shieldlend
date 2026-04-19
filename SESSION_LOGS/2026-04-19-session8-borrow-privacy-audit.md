# Session 8 — 2026-04-19 — Borrow/Repay Privacy Audit

**Branch**: `v2a-architecture`  
**Commit**: `76d439f`

---

## Problem Identified

User ran initial browser tests for deposit + withdrawal and found 3 screenshot errors.
More importantly, the user asked: *"How are we ensuring privacy in the borrow/repay case, just as we do for deposit/withdrawal?"* — specifically asking whether:

1. Borrowed ETH goes to a stealth address (not the user's wallet directly)
2. Borrowed ETH is disbursed from a random shard (not always the same shard as collateral)
3. Is there stealth→wallet auto-forward for borrowed funds?

Code audit of `BorrowForm.tsx`, `/api/borrow/route.ts`, and `LendingPool.sol` revealed 4 privacy gaps.

---

## Screenshot Error Analysis (from previous browser session)

| Screenshot | Error | Root Cause |
|---|---|---|
| 1 — "Deposit not found on-chain" | Old V2A-era note | V2A shard addresses are gone; old notes can never be withdrawn on V2B contracts. Expected — not fixable. |
| 2 — "Exceeds max transaction gas limit" | Proof fails → MetaMask can't estimate gas | BorrowForm was scanning only Shard 1. Note was on a different shard → wrong leafIndex → garbage Merkle path → `_verifyAttestation` fails → contract reverts on gas estimation. Fixed by all-shard scan. |
| 3 — "Insufficient funds for gas" | Stealth auto-forward fails | `getGasPrice()` returned exact current base fee. By execution time, fee ticked up → `balance - exactGasCost` was negative. Fixed with 20% gas price buffer. |

---

## Privacy Gaps Found and Fixed

### Gap 1 — BorrowForm scanned only Shard 1 (FUNCTIONAL + PRIVACY)

**File**: `frontend/src/components/BorrowForm.tsx:189`  
**Before**: `getAllLogs(publicClient, SHIELDED_POOL_ADDRESS)` — hardcoded Shard 1 for Merkle path and all epoch-related reads  
**After**: `getAllLogsAllShards()` + `findShardForCommitment()` — scans all 5 shards, extracts `depositShard`, routes all shard-specific calls through `depositShard`

This is the same pattern WithdrawForm already used. The gap existed because BorrowForm was written before the multi-shard refactor.

---

### Gap 2 — Borrowed ETH went directly to user's MetaMask wallet (PRIVACY)

**File**: `frontend/src/components/BorrowForm.tsx:348`  
**Before**: `recipient: address` — raw MetaMask wallet, visible on-chain in LendingPool.Loan struct  
**After**: `recipient: stealthAddress` — fresh ERC-5564 stealth address generated per borrow, same as WithdrawForm

The stealthAddress is a one-time address derived from the user's stealth meta-address. An on-chain observer sees `LendingPool → stealthAddress` and cannot link it to the user's MetaMask wallet.

---

### Gap 3 — Stealth auto-forward missing after borrow (PRIVACY + UX)

**File**: `frontend/src/components/BorrowForm.tsx` (new block added)  
**Before**: No auto-forward — user would need to manually import stealthPrivKey to MetaMask  
**After**: After borrow confirms, poll for balance on stealth address, then forward `balance - (gasPrice * 1.2 * 21000)` to connected wallet

Pattern is identical to `WithdrawForm.tsx:493–519`. The stealth private key is computed then discarded after the forward — never stored.

---

### Gap 4 — API route always used Shard 1 for disbursement (PRIVACY)

**File**: `frontend/src/app/api/borrow/route.ts`  
**Before**: Called 4-param `borrow(hash, borrowed, collateral, recipient)` → `_defaultShard` used for both collateral lock AND ETH disbursement  
**After**: Called 6-param `borrow(hash, borrowed, collateral, recipient, collateralShard, disburseShard)` with:
  - `collateralShard` = the shard where the note lives (passed from frontend's multi-shard scan)
  - `disburseShard` = randomly chosen from funded shards ≠ `collateralShard` (Fisher-Yates shuffled)

---

### Bonus Fix — Gas precision in WithdrawForm stealth auto-forward

**File**: `frontend/src/components/WithdrawForm.tsx:509`  
**Before**: `gasCost = gasPrice * 21000n` — exact, no buffer  
**After**: `bufferedGasPrice = gasPrice + gasPrice / 5n` (20% buffer), `gasCost = bufferedGasPrice * 21000n`

Same fix applied to BorrowForm's new auto-forward block.

---

## What Changed

### Frontend

**`BorrowForm.tsx`** — Major refactor of `handleBorrow()`:
- Added imports: `type Address, createWalletClient, http` (viem), `privateKeyToAccount` (viem/accounts), `baseSepolia` (chains), `useStealthKey`
- Removed hardcoded `SHIELDED_POOL_ADDRESS` dependency — all shard-specific calls now use `depositShard`
- Added `getAllLogsAllShards()` + `findShardForCommitment()` (identical to WithdrawForm)
- Added stealth key derivation step before Merkle path fetch
- Updated `fetchMerklePath()` to accept `shardAddress: Address` parameter
- Added auto-forward block after borrow confirms
- Added `"forwarding"` state to borrowStatus type
- Added `forwardedTo` state + success panel showing stealth routing message

**`WithdrawForm.tsx`** — Gas buffer fix in auto-forward:
- `getGasPrice()` result buffered +20% before computing send amount and as explicit `gasPrice` on the sendTransaction call

**`contracts.ts`** — Added 6-param borrow overload to `LENDING_POOL_ABI`:
```
"function borrow(bytes32 noteNullifierHash, uint256 borrowed, uint256 collateralAmount, address recipient, address collateralShard, address disburseShard)"
```

**`/api/borrow/route.ts`** — Rewritten:
- Accepts `collateralShard` in POST body (new required field)
- Added `createPublicClient` for shard balance checks
- `SHARD_ADDRESSES` array built from env vars
- `pickDisburseShard()`: reads ETH balances of all shards ≠ `collateralShard`, Fisher-Yates shuffles, returns first funded candidate (fallback: `collateralShard` itself)
- Calls 6-param borrow via `writeContract`

### Documentation

**`CLAUDE.md`** — Pending work updated: borrow privacy + auto-forward marked complete, repay-via-relay noted as accepted trade-off  
**`ARCHITECTURE_DECISIONS.md`** — ADR-26, ADR-27, ADR-28 appended  
**`SESSION_LOGS/`** — This file

---

## Repay Privacy (accepted trade-off — not fixed)

`repay()` is called directly from the user's wallet (`writeContractAsync`). This reveals "wallet X had an active loan at ShieldLend and repaid it" but does NOT reveal:
- Which note was used as collateral (nullifier hash in Loan struct is not publicly linkable to depositor)
- The original depositor (deposit went through relay, ADR-12)
- Where the borrowed ETH came from (now goes to stealth address)

Fixing repay-via-relay would require the relay to accept ETH from the user and call repay() on their behalf — but the user must send ETH to pay back the loan. This introduces a new ETH custody step for the relay. Accepted as a known privacy trade-off. Documented in CLAUDE.md pending work.

---

## Bugs Fixed This Session

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| S8-01 | HIGH | BorrowForm scanned only Shard 1 — notes on Shards 2–5 fail | `getAllLogsAllShards()` + `depositShard` routing |
| S8-02 | HIGH | Borrowed ETH went to user's MetaMask wallet — privacy gap | ERC-5564 stealth address as recipient |
| S8-03 | HIGH | No stealth→wallet auto-forward after borrow | Auto-forward block identical to WithdrawForm |
| S8-04 | HIGH | `/api/borrow` always used `_defaultShard` for disburse | 6-param borrow with random `disburseShard` |
| S8-05 | MEDIUM | Stealth auto-forward failed if gas price ticked up | 20% gas price buffer on both BorrowForm + WithdrawForm |

---

## Test Suite Status

86/86 forge tests still passing (no contract changes this session — all fixes are frontend + API).  
Borrow/repay browser flow ready for end-to-end testing.

## Cumulative Project Stats
| Metric | Value |
|--------|-------|
| Total sessions | 8 |
| Total bugs found | 53 |
| Total bugs fixed | 51 |
| Open (accepted) | 2 |
| Contracts deployed | 4 times (Sessions 1, 4, 6, 7) |
