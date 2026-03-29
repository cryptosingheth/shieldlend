# ShieldLend — Session Update
**Date:** 2026-03-29
**Session type:** Deployment + Frontend Debugging + Live Testnet Demo

---

## Summary

Today we deployed ShieldLend to Base Sepolia testnet, fixed 9 frontend bugs discovered during live testing, and successfully completed the full ZK privacy flow end-to-end on a public testnet:

- Deposit 0.005 ETH → shielded pool (on-chain, Base Sepolia)
- ZK withdrawal proof generated in browser (~3 seconds with sparse tree fix)
- Proof verified on zkVerify Volta testnet
- Funds withdrawn to a different address — unlinked from deposit

**Borrow feature: not yet tested. To be done next session.**

---

## Deployed Contract Addresses (Base Sepolia, Chain ID 84532)

| Contract | Address |
|----------|---------|
| ShieldedPool | `0x3704e9EE3f4895ddC10a9E6b0e788f2646b59D82` |
| LendingPool | `0xb09bC250E2348D0779A72F99997D0b4ca7817391` |
| NullifierRegistry | `0xEBEfDeA5859B248e5D6f8deF8f2658147E31E4C7` |
| CollateralVerifier | `0xdAF7BE03A40e9A007B867A8209Ba3e2237E43668` |

---

## Bugs Found and Fixed Today

### 1. MetaMask not opening on Deposit
**Symptom:** Deposit button generated the note but MetaMask popup never appeared.
**Root cause:** `deposit()` function was `async` with an `await` before `writeContract()`. MetaMask requires wallet calls to originate from a synchronous user gesture — any `await` breaks the call chain.
**Fix:** Switched from `writeContract` to `writeContractAsync`, which returns a proper Promise and keeps MetaMask happy. Removed inline `switchChainAsync` from the deposit call.

### 2. Wrong Network — Chain ID Mismatch (8453 vs 84532)
**Symptom:** Error: "Current chain (id: 8453) does not match target chain (id: 84532)"
**Root cause:** MetaMask was on Base mainnet (8453) not Base Sepolia (84532). wagmi cached the wrong chain ID from initial connection.
**Fix:** Added `useSwitchChain` + `useChainId` to `useDeposit` hook. Added a red "Wrong Network" banner to the UI with a one-click "Switch to Base Sepolia" button. Gated banner on `mounted` state to prevent SSR hydration mismatch.

### 3. Hydration Error
**Symptom:** "Hydration failed because the initial UI does not match what was rendered on the server"
**Root cause:** `useChainId()` returns different values on server (0) vs client (actual chain ID). The conditional wallet UI (address vs "Connect Wallet") differed between server HTML and client render.
**Fix:** Added `mounted` state via `useEffect(() => setMounted(true), [])`. All wallet-dependent UI gated behind `mounted &&` — server always renders "Connect Wallet", client renders real state after hydration.

### 4. eth_getLogs Range Limit on Withdrawal
**Symptom:** "RPC Request failed: eth_getLogs is limited to a 10,000 range"
**Root cause:** `WithdrawForm` queried logs from `fromBlock: 0n` (genesis) which is millions of blocks.
**Fix:** Added `getAllLogs()` helper that chunks queries into 9,000-block windows starting from the contract deployment block (`39499000`). Iterates until the current block head.

### 5. Page Unresponsive During Withdrawal
**Symptom:** Chrome "Page Unresponsive" dialog appearing during every withdrawal.
**Root cause (1):** `"web-worker": false` webpack alias was disabling snarkjs's ability to use Web Workers for background computation, forcing WASM elliptic curve math onto the main thread.
**Root cause (2):** Merkle tree reconstruction was building a full 2^20 = 1,048,576 leaf tree — ~2 million Poseidon hash operations on the main thread.
**Fix (1):** Removed `"web-worker": false` alias from `next.config.mjs` so ffjavascript can spawn Web Workers.
**Fix (2):** Replaced full-tree build with **sparse Merkle tree algorithm**:
  - Precompute 20 "zero subtree hashes": `zeros[i] = Poseidon(zeros[i-1], zeros[i-1])`
  - Only compute the ~40 nodes along the actual proof path
  - Reduces from O(2^20) = 2M hashes to O(20) = 20 hashes
  - Proof generation now completes in ~3 seconds instead of 30-60+ seconds

### 6. zkVerify Route Hanging (5+ minutes)
**Symptom:** Withdrawal stuck at "Submitting to zkVerify..." for 5+ minutes.
**Root cause:** Route was waiting for `NewAggregationReceipt` event from Volta testnet, which can take many minutes. `ShieldedPool._verifyAttestation()` is a stub (always returns true) so the aggregation path is not needed for the demo.
**Fix:** Return immediately after `transactionResult` resolves (proof verified on Volta). Removed the aggregation wait loop.

### 7. Withdrawal Spinner Stuck After Confirmation
**Symptom:** Green "Withdrawal confirmed" message appeared but spinner never stopped.
**Root cause:** `status` state was never set to `"done"` after the withdrawal transaction confirmed. `isConfirming` from wagmi staying true kept the spinner active.
**Fix:** Added `setStatus("done")` immediately after `withdraw()` is called. Updated `isLoading` condition to exclude `status === "done"` and `status === "error"`.

### 8. TypeScript: Missing `SHIELDED_POOL_ABI` import in WithdrawForm
**Symptom:** Build error: "Cannot find name 'SHIELDED_POOL_ABI'"
**Fix:** Added `SHIELDED_POOL_ABI` to the import from `@/lib/contracts`.

### 9. Circuit File Paths Wrong
**Symptom:** Browser couldn't fetch `.wasm` and `.zkey` files.
**Root cause:** `CIRCUIT_PATHS` in `circuits.ts` pointed to `_js/` subdirectories from the build folder, but we copied flat files to `public/circuits/`.
**Fix:** Updated paths to `/circuits/deposit.wasm`, `/circuits/deposit_final.zkey` etc.

---

## What Still Needs Testing

- **Borrow tab** — ZK collateral proof flow not yet tested on testnet
- **zkVerify full aggregation** — currently skipped in demo; full path needs Volta aggregation to complete
- **Multiple deposits** — sparse tree tested with 1 deposit; verify with 2+

---

## Current Git State

Latest commit: `6c81199` — all code pushed to `cryptosingheth/shieldlend` (main branch)
