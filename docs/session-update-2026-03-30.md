# ShieldLend — Session Update: 2026-03-30

## Overview

This session completed the upgrade from ShieldLend's initial working testnet build (2026-03-29)
to a production-ready protocol with real zkVerify aggregation verification, a full test suite,
and a polished multi-tab frontend. All changes were tested on Base Sepolia. The borrow/repay
flow remains untested end-to-end and is deferred to the next session.

---

## Previous Build — Challenges and Limitations

### 1. Stub ZK Verification (`_verifyAttestation`)
The previous `ShieldedPool.withdraw()` used a **stub verifier** that accepted any Groth16 proof
without actual on-chain verification. The real zkVerify aggregation path (Merkle inclusion check)
was implemented only in the dev branch and had not been merged to main.

### 2. Missing `ZkVerifyAggregation` Contract
The dev branch introduced `ZkVerifyAggregation.sol` — a contract that stores zkVerify's posted
aggregation Merkle roots. This was absent from main, meaning the withdraw flow could not
cryptographically bind proofs to on-chain attestations.

### 3. Zero Test Coverage on LendingPool
`LendingPool.t.sol` did not exist. The borrow/repay/liquidation paths had 0% test coverage.
A critical bug was already present: `ICollateralVerifier` declared `uint256[3] _pubSignals`
but `CollateralVerifier.sol` (generated from `collateral.circom`, `nPublic=2`) expected
`uint256[2]`. This would have caused every borrow call to revert.

### 4. Wrong vkHash Placeholder
`Deploy.s.sol` used `keccak256(bytes("shieldlend_withdraw_dev_placeholder"))` as the vkHash
that binds `ShieldedPool` to a specific circuit version. This is a security-critical value —
using a placeholder means any circuit with any key could be accepted.

### 5. No Gas Benchmarks
There was no measurement of actual on-chain gas costs. The Poseidon hash in `deposit()` was
suspected to be expensive but unquantified.

### 6. Frontend: Manual Note JSON Paste
Both the Withdraw and Borrow tabs required users to manually paste raw JSON note objects.
There was no persistent storage of notes across sessions. Users who lost the JSON lost access
to their funds.

### 7. Frontend: Single-Tab Layout
No dashboard, no protocol stats, no transaction history, no repay UI.

### 8. Deposit Saves Note Before Tx Confirmation
Notes were written to `localStorage` immediately after the note was generated, before MetaMask
confirmation. A rejected or failed transaction left a stale "active" note that could mislead
users into thinking they had funds in the pool.

---

## Dev Contributor Recommendations (Hridam Basu / Rump Labs Cohort)

The dev branch contained the following contributions that were reviewed and merged:

1. **`ZkVerifyAggregation.sol`** — operator-gated contract storing aggregation Merkle roots
   posted by the zkVerify relayer. Exposes `submitAggregation()` and `verifyProofAggregation()`.

2. **`Merkle.sol`** — substrate-compatible binary Merkle verifier (keccak256 variant).
   Single-leaf special case: `root = keccak256(abi.encodePacked(leaf))`.

3. **Real `_verifyAttestation()` in ShieldedPool** — replaces the stub. Reconstructs public
   inputs from withdraw call args, computes `statementHash()` (with endianness conversion for
   Substrate compatibility), then calls `verifyProofAggregation()`.

4. **`statementHash()` public view function** — callable by off-chain tooling (API routes)
   to compute the exact leaf hash without reimplementing the byte-reversal logic.

5. **New `withdraw()` signature** — removes raw Groth16 proof bytes from calldata; adds
   `domainId`, `aggregationId`, `merklePath[]`, `leafCount`, `leafIndex` instead. Gas cost
   for withdrawal drops from ~232k (Groth16 on-chain) to ~46k (Merkle inclusion only).

---

## Changes Made

### Contracts

| Change | File | Detail |
|--------|------|--------|
| Added ZkVerify aggregation layer | `src/ZkVerifyAggregation.sol` | New — from dev branch |
| Added Substrate Merkle verifier | `src/lib/Merkle.sol` | New — from dev branch |
| Added interface | `src/interfaces/IZkVerifyAggregation.sol` | New — from dev branch |
| Replaced stub verifier | `src/ShieldedPool.sol` | Full `_verifyAttestation()` + `statementHash()` + `_changeEndianness()` |
| Fixed collateral verifier interface | `src/LendingPool.sol` | `uint256[3]` → `uint256[2]` for `_pubSignals` (matched `nPublic=2` in circom) |
| Fixed vkHash | `script/Deploy.s.sol` | Real SHA-256 of `withdraw_vkey.json`: `0x364ba9c10e3cd357...` |
| Verifier strategy | `src/verifiers/` | Kept main branch verifiers (Option A) — compatible with existing `.zkey` files; avoided unnecessary new trusted setup |

### Tests

| File | Tests | Coverage |
|------|-------|----------|
| `test/LendingPool.t.sol` | 29 (27 unit + 2 fuzz) | 0% → full borrow/repay/collateral paths |
| `test/Gas.t.sol` | 7 benchmarks | deposit 879k, withdraw 46k, borrow 368k, repay 11k, Groth16 232k, submitAggregation 32k, verifyProofAggregation 2k |
| `test/ZkVerifyAggregation.t.sol` | From dev | Aggregation storage and Merkle verification |
| `test/ShieldedPool.t.sol` | Replaced with dev | Multi-leaf aggregation, fuzz withdraw |
| `test/Groth16Verifiers.t.sol` | Rewritten | Updated proof fixtures to match main branch zkeys (dev branch had regenerated zkeys — incompatible) |

**Total: 57 tests passing, 0 failing.**

### Frontend

| Change | File | Detail |
|--------|------|--------|
| Updated withdraw ABI + hook | `src/lib/contracts.ts` | 9-param `withdraw()`, added `statementHash`, `useWithdraw` with switchChain guard |
| Updated WithdrawForm | `src/components/WithdrawForm.tsx` | Pass new params; note dropdown from vault; mark spent on success |
| Note vault | `src/lib/noteStorage.ts` | New — localStorage CRUD keyed by nullifierHash; `loadNotes`, `saveNote`, `markNoteSpent` |
| zkVerify API route | `src/app/api/zkverify/route.ts` | Calls `pool.statementHash()` on-chain; posts single-leaf aggRoot to `ZkVerifyAggregation` as operator; returns `merklePath:[], leafCount:1, leafIndex:0` |
| Borrow API route | `src/app/api/borrow/route.ts` | New — server-side: zkVerify → `snarkjs.exportSolidityCallData` → `LendingPool.borrow()` |
| Enhanced BorrowForm | `src/components/BorrowForm.tsx` | Saved-note dropdown; health factor preview (green/amber/red); integrated repay section with live loan details |
| DepositForm | `src/components/DepositForm.tsx` | Note saved to vault only after `isSuccess` (tx confirmed); uses `useRef` + `useEffect` pattern |
| Dashboard | `src/components/Dashboard.tsx` | Pool stats (TVL, deposit count, utilization); user note list with active/spent status; mounted guard for hydration |
| History | `src/components/History.tsx` | Protocol event timeline using exact `topic[0]` hashes; correct ABI slot parsing; clickable BaseScan links |
| Layout | `src/app/page.tsx` | 5-tab dashboard-first layout (Dashboard / Deposit / Withdraw / Borrow / History) |

---

## Bugs Found and Resolved During Local Testing

### Bug 1: React Hydration Mismatch
**Symptom:** `Unhandled Runtime Error: Expected server HTML to contain a matching <h2>`
**Root cause:** `Dashboard` conditionally rendered `<h2>` tags based on `address` (wagmi hook,
undefined on server). Server and client renders diverged.
**Fix:** Added `mounted` state; `if (!mounted) return null` prevents any server-side render
of wallet-dependent UI.

### Bug 2: TVL Does Not Decrease After Withdrawal
**Symptom:** TVL showed 0.005 ETH after funds were withdrawn.
**Root cause:** Dashboard summed all `Deposit` event amounts but never subtracted `Withdrawal`
amounts. The event type detection used `topics.length` as a heuristic — unreliable since both
Deposit and Withdrawal have 2 indexed topics.
**Fix:** Filter by exact `topic[0]` hash (`0x5371f0...` for Deposit, `0x4206db...` for
Withdrawal). TVL = `sum(deposits) - sum(withdrawals)`.

### Bug 3: History Tab Showed Only "Withdrawal" Events, Not Deposits
**Symptom:** History showed 2 withdrawals; 0 deposits displayed.
**Root cause:** History.tsx used `topics.length === 2` to detect withdrawals but
`Deposit(bytes32 indexed, uint32, uint256, uint256)` also has 2 topics (1 indexed). The
condition matched all pool logs as withdrawals.
**Fix:** Use `topic[0]` hash constants for each event type. Amount parsed from correct ABI
data slot per event (Deposit: slot 2; Withdrawal: slot 1).

### Bug 4: History Rows Not Clickable
**Symptom:** Clicking a history row did nothing; no way to inspect tx details.
**Fix:** Wrapped each row in `<a href="https://sepolia.basescan.org/tx/{hash}" target="_blank">`.

### Bug 5: Stale Notes Created for Failed Deposits
**Symptom:** Rejecting a MetaMask deposit prompt still saved a note to the vault. The note
appeared as "Active" in the dashboard despite no funds ever reaching the pool. Attempting to
withdraw with this note produced `InvalidProof()` revert.
**Root cause:** `saveNote()` was called immediately after note generation, before `await deposit()`.
**Fix:** `DepositForm` now stores the pending note in a `useRef`. A `useEffect` watching
`isSuccess` saves it to the vault only when the transaction is confirmed. If the tx fails,
`pendingNote.current = null` discards it.

### Bug 6: `InvalidProof()` Revert on First Withdraw Attempt
**Symptom:** Withdrawal reverted with selector `0x09bde339` ("exceeds max transaction gas
limit" in MetaMask, which surfaces revert failures this way).
**Root cause:** User selected the stale note (from Bug 5 above). Its commitment was never
inserted into the Merkle tree, so no valid root exists for it. `_verifyAttestation` computed
a `statementHash` that did not match any stored aggregation root.
**Fix:** Resolved by Bug 5 fix (stale notes no longer created). Second attempt with the
correct confirmed note succeeded.

---

## Deployed Contracts — Base Sepolia (2026-03-30)

| Contract | Address |
|----------|---------|
| NullifierRegistry | `0xb297fC52b3F831c36f828539C7F0456fbD587fb6` |
| ShieldedPool | `0xDB027879C3997D29406325A386aa4C61c590AE3B` |
| CollateralVerifier | `0x9Ee7d0de53c0D5a542AeA1728c298f4A59300c72` |
| LendingPool | `0xcb5e02540697C828753b180b2ff34C3c08B37FE4` |
| ZkVerifyAggregation | `0x2895519f1a18413F5AB435EeAA71484C47CAd9cA` |

vkHash (withdraw circuit): `0x364ba9c10e3cd357f531ca59f592a3efa5cc610f99bb3e71973b961f4937d744`

---

## What Was Verified Working (Live Testnet)

- Deposit ETH → ShieldedPool, note auto-saved to vault after confirmation
- ZK withdrawal proof generated in-browser (~10s)
- Proof submitted to zkVerify Volta → aggregation root posted to ZkVerifyAggregation
- `ShieldedPool.withdraw()` Merkle verification succeeds (46k gas)
- Funds arrive at recipient address (unlinkable from deposit)
- Dashboard TVL updates correctly (deposit increases, withdrawal decreases)
- History tab shows both Deposit and Withdrawal events with correct amounts
- History rows link to BaseScan

## What Remains Untested

- Borrow tab end-to-end (ZK collateral proof → zkVerify → `LendingPool.borrow()`)
- Repay flow
- Multiple deposits + withdrawal (sparse Merkle tree with n > 1 deposits)
- On-load nullifier registry sync (Option B — derive spent status from chain, not localStorage)

## Next Steps

1. Test borrow/repay flow on Base Sepolia
2. Add on-load nullifier check: cross-reference active notes against `NullifierRegistry.isSpent()`
3. Push final build to GitHub: `cryptosingheth/shieldlend`
