# Session 4 — 2026-04-07 — Circuit Fixes + Security Fixes + Redeploy

**Branch**: `v2a-architecture`  
**Commits**: `8049365`, `85dc407`, `fe81dd3`, `6cafe06`, `5ec1906`

## What Changed

Critical circuit and contract security fixes found during deeper audit. Contracts redeployed to Base Sepolia.

## Bugs Fixed
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| H-1 | HIGH | Denomination not validated in circuit — could withdraw wrong amount | Added denomination range check to `withdraw_ring.circom` |
| H-3 | HIGH | Ring-index-dependent nullifier — different ring index = different nullifierHash = double-spend | Changed nullifierHash to `Poseidon(nullifier)` — ring-index-independent |
| C-1 (session 4 variant) | CRITICAL | Operator gate missing from borrow | Added `onlyOperator` modifier |
| C-2 (session 4 variant) | CRITICAL | Liquidation collateral unlock missing | Added explicit unlock |
| H-2 | HIGH | `disburseLoan()` uncapped amount | Added `collateralAmount` bound |
| M-1 | MEDIUM | ETH trapped in LendingPool after repay | Fixed routing — ETH forwarded back to ShieldedPool |

## Other Changes
- Per-note epoch countdown (50-block privacy window per deposit)
- Cross-tab withdrawal progress indicator
- Personal 50-block privacy window enforced in WithdrawForm

## Redeployment
Contracts redeployed after circuit recompile. New addresses recorded in AUDIT_REPORT.md Session 4 section.
