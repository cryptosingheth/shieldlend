# ShieldLend V1 — State Summary

**Completed:** 2026-03-30 | **Network:** Base Sepolia (Chain ID 84532) | **Tests:** 57 passing

---

## Deployed Contracts

| Contract | Address |
|----------|---------|
| NullifierRegistry | `0xb297fC52b3F831c36f828539C7F0456fbD587fb6` |
| ShieldedPool | `0xDB027879C3997D29406325A386aa4C61c590AE3B` |
| CollateralVerifier | `0x9Ee7d0de53c0D5a542AeA1728c298f4A59300c72` |
| LendingPool | `0xcb5e02540697C828753b180b2ff34C3c08B37FE4` |
| ZkVerifyAggregation | `0x2895519f1a18413F5AB435EeAA71484C47CAd9cA` |

`vkHash` (withdraw circuit): `0x364ba9c10e3cd357f531ca59f592a3efa5cc610f99bb3e71973b961f4937d744`

---

## What Works (Live Tested on Base Sepolia)

- Deposit ETH → ShieldedPool — note auto-saved to vault after tx confirms
- ZK withdrawal proof generated in browser (~10s, Groth16 via snarkjs WASM)
- Proof submitted to zkVerify Volta → single-leaf aggregation root posted to ZkVerifyAggregation
- `ShieldedPool.withdraw()` Merkle verification succeeds (46k gas)
- Funds arrive at recipient address, unlinkable from deposit address on-chain
- Dashboard TVL correct (deposits minus withdrawals, filtered by exact topic0 hash)
- History tab shows Deposit + Withdrawal events with correct amounts and BaseScan links
- 5-tab layout: Dashboard / Deposit / Withdraw / Borrow / History
- 57 forge tests passing

---

## What Is Not Yet Tested

- Borrow tab end-to-end (ZK collateral proof → zkVerify → `LendingPool.borrow()`)
- Repay flow
- Multiple deposits + withdrawal (sparse Merkle tree with n > 1 leaves)
- On-load nullifier sync from `NullifierRegistry.isSpent()`

---

## Key Circuits

| Circuit | Constraints | Keys |
|---------|------------|------|
| `circuits/withdraw.circom` | ~8k | `circuits/keys/withdraw_final.zkey` |
| `circuits/collateral.circom` | ~8k | `circuits/keys/collateral_final.zkey` |

Both are Groth16. Verification keys exported to `circuits/keys/*_vkey.json`. Verifier contracts in `contracts/src/verifiers/`.

---

## ZK Proof Flow (Withdraw)

1. Frontend generates proof: `snarkjs.groth16.fullProve(input, withdraw.wasm, withdraw_final.zkey)`
2. POST to `/api/zkverify`: server calls `pool.statementHash()` on-chain, submits proof to zkVerify Volta, posts single-leaf aggregation root to `ZkVerifyAggregation` as operator
3. Frontend calls `ShieldedPool.withdraw(nullifierHash, root, recipient, amount, domainId, aggregationId, [], 1, 0)`
4. `ShieldedPool._verifyAttestation()` reconstructs the statement hash and verifies Merkle inclusion against the stored aggregation root

---

## Known Issues / V2 Motivation

1. **Solvency bug:** `withdraw()` does not check if nullifier is locked as collateral — user can borrow then withdraw, leaving loan open with no collateral
2. **Note theft:** `StoredNote` (nullifier + secret) stored in plaintext localStorage — XSS or malicious extension can steal funds
3. **Timing correlation:** Commitments inserted immediately on deposit — timing + leaf index gives a strong de-anonymization signal in a sparse pool
4. **Flat interest rate:** `interestRateBps` is a fixed constant regardless of utilization
5. **Time-based liquidation:** Liquidation triggered by time elapsed, not health factor
6. **Borrow flow untested:** End-to-end borrow/repay path not verified on-chain

All six issues are addressed in the V2 architecture plan (`docs/v2-architecture-plan.md`).
