# Session 10 — 2026-11-01 — Promote V2B to main + Reproducibility Fixes

**Branch**: `main` (fast-forwarded from `v2a-architecture` `95d8814`)  
**Commits**: `468ee6a`, `eaa10e3`, `c060ff2`, `88ca617`

---

## What Was Done

- Fast-forwarded `main` from the V1 head `16cbd63` to `v2a-architecture` `95d8814`. `main` had no commits of its own, so nothing was rewritten.
- Did not merge `shieldlend-solana` or `claude/review-implementation-plan-PfjH3`. They are the Solana docs fork that deletes the EVM code, and that work now lives in `cryptosingheth/shieldlend-solana`.
- Verified from a fresh clone, then fixed what blocked a fresh clone from building and running (below).

---

## Bugs Fixed This Session

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| S10-01 | HIGH | `live-test.mjs` (both copies) hardcoded the relay/deployer private key in a public repo | Read `DEPLOYER_PRIVATE_KEY` from env and exit if it is missing (ADR-33) |
| S10-02 | MEDIUM | `next build` failed: `pickDisburseShard` typed its param as the generic `ReturnType<typeof createPublicClient>`, which the Base Sepolia client (OP-stack `deposit` tx type) does not satisfy | Narrow the param to `Pick<PublicClient, "getBalance">` |
| S10-03 | MEDIUM | `next build` failed: `circomlibjs` and `snarkjs` have no typings | `frontend/src/types/zk-libs.d.ts` module declarations |
| S10-04 | MEDIUM | Fresh clone could not prove: `*.zkey` was gitignored, but the frontend fetches it from `/circuits/` | Commit `withdraw_ring.zkey` + `collateral_ring.zkey` (ADR-32) |
| S10-05 | LOW | `npm ci` impossible (lockfile gitignored), and plain `npm install` hits an ERESOLVE peer conflict (`@wagmi/connectors@8` vs wagmi 2) | Commit `package-lock.json`, add `frontend/.npmrc` with `legacy-peer-deps=true` |
| S10-06 | MEDIUM | Fresh clone could not withdraw or borrow: `/api/zkverify` and `/api/borrow` read `circuits/keys/*_vkey.json`, which `keys/` in `.gitignore` excluded | Commit both vkey JSONs (checked equal to the vkeys exported from the shipped zkeys) |
| S10-07 | HIGH (open) | `recipient` is not a circuit signal; it is bound only by the operator's attestation leaf, so a copied proof could be paired with another recipient | Documented in `docs/circuits.md` and README; fix = recipient as public input, new setup, redeploy |
| S10-08 | LOW | `docs/circuits.md` described the pre-audit circuits (2-input commitment, ring-index nullifier, recipient as public input, ~24k constraints) | Rewritten from the actual circuits: 13,588 / 13,691 constraints from the r1cs, which match the zkey headers |

`npm run dev` skips type-checking, which is why S10-02 and S10-03 never surfaced during development.

---

## Verification

| Check | Result |
|-------|--------|
| `forge test` (pristine clone) | 86/86 passing |
| `npm ci` with no flags (pristine clone) | OK |
| `npx tsc --noEmit` / `next build` | Clean / passing |
| `live-test.mjs` against Base Sepolia | 32/32 passing (test deposit tx at block 53235272) |
| Frontend zkeys vs `circuits/keys` finals | Byte-identical; exported withdraw vkey matches `withdraw_ring_vkey.json` |

---

## Open Items

1. **Rotate the relay/deployer key.** It was public in branch history from April until this session. It is the LendingPool admin and operator and the ZkVerifyAggregation operator, so anyone holding it can post aggregation roots. Testnet only; it holds no mainnet balance. Rotation means a full redeploy: `ZkVerifyAggregation.operator` and `LendingPool.admin` are `immutable`, and `ShieldedPool` / `NullifierRegistry` have no admin-transfer function. No script in `contracts/script/` deploys `ZkVerifyAggregation` (the V1 `Deploy.s.sol` that did was removed in `b195ce2`).

Also found: `b195ce2` (2026-04-09, labelled docs) deleted the whole tree; V2A+ re-added only V2 files, so `LICENSE` was lost. Restored from the original MIT text.
2. Browser re-test of the stealth auto-forward (ADR-29/30/31) is still pending.
3. Borrow → repay still not confirmed end-to-end in the browser.

---

## Cumulative Project Stats

| Metric | Value |
|--------|-------|
| Total sessions | 10 |
| Total bugs found | 64 |
| Total bugs fixed | 61 |
| Open | 3 (2 accepted trade-offs + S10-07) |
| Contracts deployed | 4 times (Sessions 1, 4, 6, 7) |
