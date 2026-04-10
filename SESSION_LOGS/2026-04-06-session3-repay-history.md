# Session 3 — 2026-04-06 — Repay Dropdown + History UI

**Branch**: `v2a-architecture`

## What Changed

- `RepayForm` / repay dropdown — Bug 20 fix: repay loan selection was broken
- `History.tsx` — loan history display wired correctly
- Stale `totalOwed` fix — interest accrual displayed stale cached value; now re-fetched on render

## Bugs Fixed
| # | Area | Issue | Fix |
|---|------|-------|-----|
| 19 | RepayForm | Loan dropdown not populating | Fixed loan ID enumeration |
| 20 | RepayForm | `totalOwed` showed stale value after interest accrual | Re-fetch on component mount |
| 21 | History.tsx | Loan history empty despite on-chain loans | Fixed event log scanning block range |
