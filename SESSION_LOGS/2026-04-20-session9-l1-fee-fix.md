# Session 9 — 2026-04-20 — Stealth Auto-Forward L1 Data Fee Fix

**Branch**: `v2a-architecture`  
**Commit**: `31af4eb`

---

## Problem Identified

After Session 8 shipped the stealth auto-forward for both `WithdrawForm` and `BorrowForm`, browser testing still showed:

```
insufficient funds for gas * price + value: have 1000000000000000 want 1000000910355150
```

The Session 8 fix (ADR-28) added a 20% buffer on the L2 gas price. This was insufficient because it addressed gas *price* volatility but not the structural issue: **Base charges a separate L1 data fee** that `getGasPrice()` does not return.

---

## Root Cause Analysis

Base is an Optimism-stack L2. Every transaction incurs two fees:

| Fee component | Source | Amount (testnet) |
|---|---|---|
| L2 execution gas | `getGasPrice() * gasLimit` | ~21000 gwei |
| L1 data fee | Sequencer charges for posting calldata to Ethereum L1 | ~910,355,150 wei |

`getGasPrice()` returns only the L2 execution fee. The L1 data fee is charged separately by the sequencer at execution time.

**Before fix**: `sendAmount = balance - (bufferedGasPrice * 21000n)`  
`balance - sendAmount = bufferedGasCost` which does NOT include L1 fee.  
Tx total cost = `bufferedGasCost + L1fee > balance` → always fails.

**Evidence from screenshot**: deficit = 910,355,150 wei = exactly the L1 data fee.

---

## Bugs Fixed This Session

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| S9-01 | HIGH | Stealth auto-forward always fails on Base — L1 data fee not reserved in gas calculation | Add `L1_DATA_FEE_RESERVE = 10_000_000_000n` to gasCost in both WithdrawForm and BorrowForm |
| S9-02 | HIGH | markNoteSpent called after auto-forward — failed forward leaves note appearing withdrawable despite nullifier being spent on-chain | Move markNoteSpent immediately after on-chain tx confirms, before auto-forward attempt |
| S9-03 | MEDIUM | Stealth private key silently discarded on forward failure — ETH stuck permanently in stealth address with no recovery path | Wrap auto-forward in separate try/catch; store key in `forwardFailKey` state and show recovery panel |

---

## What Changed

### `frontend/src/components/WithdrawForm.tsx`

1. **New state**: `const [forwardFailKey, setForwardFailKey] = useState<string | null>(null)`
2. **markNoteSpent moved**: Immediately after `withdraw()` confirms (`WithdrawForm.tsx:489–493`), before auto-forward attempt. The note filter and local storage update both happen here.
3. **Auto-forward wrapped in try/catch** (`WithdrawForm.tsx:511–556`):
   - `L1_DATA_FEE_RESERVE = 10_000_000_000n` added to `gasCost`
   - `setStatus("done")` is now unconditional — runs whether forward succeeds or fails
   - On catch: `setForwardFailKey(stealthPrivKey as string)` to expose key for recovery
4. **Recovery panel JSX** (`WithdrawForm.tsx:788–810`): shown when `status === "done" && forwardFailKey`; displays stealth private key with Copy button and clipboard deletion warning

### `frontend/src/components/BorrowForm.tsx`

1. **L1_DATA_FEE_RESERVE** added to auto-forward gasCost calculation (`BorrowForm.tsx:439–440`), matching WithdrawForm pattern

### `ARCHITECTURE_DECISIONS.md`

ADR-29: L1 data fee reserve in stealth auto-forward  
ADR-30: markNoteSpent before auto-forward  
ADR-31: Stealth private key recovery panel

---

## Test Suite Status

86/86 forge tests passing (no contract changes this session).  
WithdrawForm and BorrowForm auto-forward ready for browser re-test.

---

## Cumulative Project Stats

| Metric | Value |
|--------|-------|
| Total sessions | 9 |
| Total bugs found | 56 |
| Total bugs fixed | 54 |
| Open (accepted trade-offs) | 2 |
| Contracts deployed | 4 times (Sessions 1, 4, 6, 7) |
