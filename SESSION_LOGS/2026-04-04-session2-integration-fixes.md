# Session 2 — 2026-04-04 — Integration Bug Fixes (Bugs 4–18)

**Branch**: `v2a-architecture`  
**Commits**: `1507411`, `4dcbc93`, `15ead14`, `d1282a5`, `b172c53`, `b15a9c4`, `12f81b8`, `85cf915`

## What Changed

End-to-end integration testing revealed 15 additional bugs after Session 1's initial build. Full deposit → withdraw flow confirmed working by end of session.

## Bugs Fixed
| # | Area | Issue | Fix |
|---|------|-------|-----|
| 4 | circuits.ts | recipient/relayer/fee signals in withdraw proof input | Removed — not in V2A circuit |
| 5 | WithdrawForm | Batch-check all note flush statuses on load | Fixed counter reappearance |
| 6 | api/zkverify | Statement hash inputs mismatched between route and contract | Aligned input ordering |
| 7 | WithdrawForm | Root freshness bug — stale root used after epoch | Fixed root re-fetch |
| 8 | WithdrawForm | `getLogs` margin too tight — missed events at epoch boundary | Widened block range |
| 9 | WithdrawForm | `upToBlock` threading race | Fixed async sequencing |
| 10 | api/borrow | Borrow route wiring gaps | Fixed |
| 11 | History.tsx | Missing import and display errors | Fixed |
| 12 | DepositForm | Encryption not triggered on save | Fixed |
| 13–15 | Multiple | Circuit input field name mismatches | Fixed to match circom signal names |
| 16 | WithdrawForm | Pending notes not all marked ready after flush | Fixed — marks ALL pending notes |
| 17 | WithdrawForm | Stale countdown after flush (effectiveLastEpochBlock) | Fixed |
| 18 | WithdrawForm | Pending banner shown when epoch already ready | Fixed with `canFlushNow` check |

## End-to-End Status at End of Session
- Deposit → confirmed working
- Withdraw (with proof) → confirmed working end-to-end
- Borrow → frontend wired, not yet live-tested
