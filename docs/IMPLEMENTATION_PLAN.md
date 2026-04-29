# ShieldLend Solana — Approved Implementation Plan

This plan is scoped only to the ShieldLend Solana repo. The EVM repo and the `v2a-architecture` branch are read-only references and must not be modified by this implementation.

---

## 0. Architecture Validation and Documentation Pass

Status: documentation finalization complete before coding.

Goals:
- Validate that every privacy claim maps to a concrete mechanism.
- Remove overclaims where a proof does not hide a public transfer.
- Keep borrow amounts public or bucketed for MVP so LTV, interest, reserves, liquidation, and bad-debt prevention remain deterministic.
- Add clear diagrams and pitch materials for mentors, judges, and investors.
- Keep `docs/VISUAL_FLOWS.md` as the plain-English flow source and `docs/PRIVACY_AND_THREAT_MODEL.md` as the combined privacy/security source.

Key decisions:
- Borrow amount public/bucketed leaks amount metadata but does not link borrower to depositor.
- Full repayment amount privacy requires MagicBlock Private Payments, not only a ZK private input.
- Umbra is the address-layer exit and scoped-disclosure tool; MagicBlock is the private repayment settlement rail.
- Dummy commitments use MagicBlock VRF plus PER/TEE private entropy; no known-zero or public-only dummy preimages.
- Liquidation MVP is conservative: full liquidation only, minimum position size, reserve accounting, stale-oracle pause, and breach confirmation.

---

## 1. Smart Contracts / Solana Programs

Language: Rust with Anchor.

Programs to write:

| Program | Responsibility |
|---|---|
| `programs/shielded_pool` | SOL custody, Poseidon Merkle tree, deposit queue, withdrawal proof verification, PER deposit/exit delegation, VRF dummy insertion |
| `programs/nullifier_registry` | PDA state for `Active`, `Locked`, and `Spent` nullifiers; authorized writer checks |
| `programs/lending_pool` | Kamino-derived interest model, borrow/repay/liquidate state machine, collateral proof verification, private payment receipt verification, IKA/FutureSign/Encrypt integration points |

Implementation order:
1. Initialize Anchor workspace.
2. Define accounts and errors only.
3. Implement `nullifier_registry` state transitions with tests.
4. Implement `shielded_pool` deposit/withdraw skeleton and Merkle root handling.
5. Implement `lending_pool` borrow/repay/liquidate skeleton.
6. Add proof verifier calls after circuit outputs are stable.
7. Add MagicBlock, IKA, Encrypt, and Umbra adapters.

DeFi safety invariants:
- `shielded_pool` is the only SOL custody program.
- `lending_pool` cannot unlock collateral unless proof verification and settlement verification both pass.
- `Locked` nullifiers cannot withdraw.
- Liquidation cannot execute unless confirmed through the FHE/keeper flow and FutureSign condition.
- Reserve/bad-debt accounting is explicit before collateral release.

---

## 2. Circuits

Language: Circom + Groth16, compiled with snarkjs and verified with `groth16-solana`.

### Imported / Adapted from V2A Architecture

These are copied as design lineage only, then updated inside the Solana repo:

| Circuit | Source posture | Required Solana changes |
|---|---|---|
| `withdraw_ring.circom` | Import/adapt existing ring + Merkle logic | Add `leaf_index`; update nullifier formula to `Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)`; recompile WASM/VK |
| `collateral_ring.circom` | Import/adapt existing collateral LTV logic | Same nullifier update; keep `borrowed` public/bucketed for deterministic LTV |

No changes are made to the original EVM/V2A branch.

### Written From Scratch

| Circuit | Purpose |
|---|---|
| `repay_ring.circom` | Prove knowledge of locked collateral nullifier and bind `loanId`, `outstanding_balance`, and `settlementReceiptHash` |

`repay_ring` does not claim that a private input alone hides repayment amount. The private amount is handled by MagicBlock Private Payments; the circuit binds the receipt to the loan.

---

## 3. Protocol Integrations

| Protocol | Role | Implementation rule |
|---|---|---|
| MagicBlock PER | Deposit batching and unified exit batching | Use real devnet adapter first; fallback only if labeled |
| MagicBlock VRF | Dummy insertion randomness | Use VRF as unbiasable seed plus PER private entropy |
| MagicBlock Private Payments | Repayment settlement privacy | Primary choice for full repayment amount privacy |
| IKA dWallet | Relay authorization and disbursement signing | No server private-key relay |
| IKA FutureSign | Borrow-time liquidation consent | Liquidation executes only under confirmed condition |
| Encrypt FHE | Encrypted oracle/health and aggregate collateral coverage | Do not overclaim encrypted borrow amount in MVP |
| Umbra SDK | Withdrawal/disbursement stealth addresses and scoped disclosure | Address-layer privacy, not repayment settlement |
| Kamino klend | Interest model and lending mechanics | Fork/adapt conservatively; preserve rate/accounting invariants |

---

## 4. Frontend and Product Design

Language: TypeScript / React / Next.js.

Design should begin during implementation, not after all contracts are done, because privacy mode, receipts, local history, and disclosure UX affect product architecture.

Core screens:
- Deposit: denomination picker, privacy mode indicator, note backup status.
- Withdraw: note selector, stealth address generation, sweep warning.
- Borrow: collateral note selector, borrow bucket selector, health factor preview, FutureSign consent.
- Repay: private payment settlement status, receipt binding, collateral unlock state.
- History: local encrypted journal with exportable disclosure packets.
- Protocol status: Full Privacy / Degraded / Emergency.

Design principles:
- Product first screen, not a marketing landing page.
- Quiet operational dashboard style.
- Clear mode warnings when privacy degrades.
- No claims of full amount privacy unless private payments are active.

---

## 5. Transaction History and Viewing Keys

Implementation scope:
- Extend client vault to include encrypted `HistoryRecord` entries.
- Record deposit, withdraw, borrow, repay, liquidation, proof public signals hash, tx signature, Merkle root, nullifier hash, and private payment receipt hash.
- Build scoped disclosure export for selected records only.
- No protocol global viewing key.
- No operator deanonymization key.

---

## 6. Tests and Verification

Test layers:
- Circuit witness tests for valid/invalid nullifier, Merkle path, LTV, and repayment receipt binding.
- Anchor unit tests for nullifier state transitions.
- Lending invariant tests for borrow, repay, liquidation, reserves, and bad debt.
- Integration tests for degraded-mode privacy-claim changes.
- Frontend tests for mode banners and disclosure export.

Security review checklist before demo:
- Search for stale nullifier formula.
- Search for repayment amount overclaims.
- Confirm dummy formula is not public-only.
- Confirm no EVM/V2A branch files were modified.
- Confirm fallback modes visibly reduce claims.

---

## 7. Visuals and Pitch Materials

Deliverables in this repo:
- `docs/VISUAL_FLOWS.md`: Mermaid diagrams for each privacy flow.
- `docs/PITCH_DECK.md`: slide-by-slide pitch story.

PPTX creation can happen after these docs stabilize, using the same storyline. The Markdown deck outline should exist now so product, architecture, and pitch remain aligned during coding.
