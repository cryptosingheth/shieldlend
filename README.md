# ShieldLend

**ZK-based private DeFi lending protocol on Base with zkVerify proof verification.**

![Status](https://img.shields.io/badge/status-v2%20architecture%20proposal-orange)
![Chain](https://img.shields.io/badge/chain-Base%20Sepolia-blueviolet)
![License](https://img.shields.io/badge/license-MIT-green)
![Circuits](https://img.shields.io/badge/circuits-Circom%20%2B%20snarkjs-blue)

---

> **This branch (`v2-architecture`) proposes the V2 redesign of ShieldLend.**
> V1 is deployed and working on Base Sepolia (57 tests passing, live contracts). This branch documents the architectural upgrade from V1 to V2. No contract or circuit code has changed yet — this is the design-first review branch.
> Full specification: [`docs/v2-architecture-plan.md`](docs/v2-architecture-plan.md) | V1 state: [`docs/v1-summary.md`](docs/v1-summary.md)

---

## The Problem

Every action on a public DeFi lending protocol is fully transparent. When you deposit collateral, borrow against it, or repay — the exact amount, your wallet address, and the timing of every action are permanently visible on-chain. Anyone can track positions, target liquidations, or build a complete financial profile of any user.

Even protocols using ZK proofs (Tornado Cash pattern) leak information through timing correlation: a sparse pool with few deposits makes it trivial to link a withdrawal to a specific deposit, regardless of the cryptographic proof strength.

DeFi doesn't have to work this way.

---

## The V2 Solution

ShieldLend V2 implements **four independent privacy layers** on top of a Groth16 ZK proof system — the same cryptographic model that powers Tornado Cash, extended to a lending context with user-base-independent anonymity guarantees.

| Layer | What it hides | How |
|-------|--------------|-----|
| 1: ZK circuit | Which deposit = this withdrawal (transaction graph) | Groth16 + nullifier |
| 2: Epoch batch insertion | Deposit timestamp vs. Merkle leaf index | 50-block batches + `prevrandao` shuffle |
| 3: Adaptive dummy commitments | Sparse pool timing patterns — user-base independent | Protocol inserts synthetic leaves each epoch |
| 4: Ring selection circuit | Which commitment in the time window is mine | `withdraw_ring.circom` (k=16 ring, 300 min anonymity set) |
| 4+: ERC-5564 stealth addresses | Recipient identity on withdrawal/borrow | One-time ECDH-derived addresses |

Combined result: an observer sees ETH leaving ShieldedPool to an unlinkable stealth address. They cannot determine which deposit it corresponds to, when the depositor deposited, or who the recipient is — even at protocol launch with zero real users.

---

## V1 → V2 Architecture Changes

| Component | V1 | V2 |
|-----------|----|----|
| **ETH custody** | ShieldedPool + LendingPool both hold ETH | ShieldedPool only — single unified vault |
| **LendingPool** | Custom standalone | Pure accounting — zero ETH custody |
| **Denominations** | Open (any amount) | Fixed: 0.1, 0.5, 1.0 ETH — single Merkle tree |
| **Solvency** | Critical bug: collateral note withdrawable while loan is open | Nullifier locking + auto-settle on withdrawal |
| **Note storage** | Plaintext localStorage | AES-256-GCM encrypted, wallet-derived key |
| **Commitment insertion** | Immediate on deposit | Queued → batched every 50 blocks |
| **Anonymity set** | Depends on real user count | User-base independent (adaptive dummies) |
| **Circuits** | `withdraw.circom` (full tree membership) | `withdraw_ring.circom` (k=16 ring, last 30 epochs) |
| **Recipient privacy** | Recipient address is public input | ERC-5564 stealth address |
| **Interest rate** | Flat `interestRateBps` | Aave v3 kinked two-slope utilization curve |
| **Liquidation** | Time-based | Health factor (`HF = collateral × threshold / owed`) |

---

## How It Works (V2)

```
DEPOSIT                                  WITHDRAW
───────                                  ────────
1. Deposit exactly 0.1, 0.5, or 1.0 ETH 1. Load encrypted note (wallet-derived key)
2. Compute commitment = Poseidon(denom, s)2. Select ring of 16 commitments from
3. Commitment queued in pendingCommitments   last 30 epochs (real + dummies mixed)
4. Every 50 blocks: flushEpoch() inserts  3. Generate ring proof in browser (WASM):
   real + dummy commitments in shuffled      - Proves ring membership (k=16)
   order using prevrandao                    - Proves global Merkle inclusion
5. Note saved to localStorage (encrypted)   - Binds nullifier to ring position
                                          4. Submit proof → zkVerify → attestation
BORROW                                    5. Provide ERC-5564 stealth address
──────                                    6. ShieldedPool verifies, sends ETH to
1. ZK-prove collateral note ownership        stealth address
2. Collateral nullifier locked on-chain      (unlinkable to deposit address)
3. ETH disbursed to stealth address       7. If loan open: auto-settle deducted,
4. Loan tracked in LendingPool (acctg)       remainder to recipient
```

---

## Architecture (V2)

```
┌──────────────────────────────────────────────────────────────┐
│  USER BROWSER                                                │
│  Next.js + wagmi + snarkjs (WASM) + @scopelift/stealth-sdk  │
│                                                              │
│  Deposit → queue commitment (fixed denom)                    │
│  Withdraw → ring proof (k=16) → stealth address             │
│  Borrow → collateral ring proof → stealth disbursement       │
│  Note storage → AES-256-GCM (wallet-derived key)            │
└────────────────────────┬─────────────────────────────────────┘
                         │ Groth16 ring proof
         ┌───────────────┴──────────────┐
         │                              │
┌────────▼───────────────┐   ┌──────────▼──────────────┐
│  SMART CONTRACTS        │   │  ZKVERIFY VOLTA          │
│  (Solidity on Base)     │   │                          │
│                         │   │  Verify ring proof       │
│  ShieldedPool.sol       │   │  (91% cheaper than L1)   │
│  • Single ETH vault     │   │  Emit attestation root   │
│  • Epoch queue + flush  │   │  → ShieldedPool reads    │
│  • Dummy insertion      │   └──────────────────────────┘
│  • Nullifier locking    │
│  • Auto-settle withdraw │
│  • Depth-24 Merkle tree │
│                         │
│  LendingPool.sol        │
│  • Accounting only      │
│  • Utilization curve    │
│  • HF-based liquidation │
│  • No ETH custody       │
│                         │
│  NullifierRegistry.sol  │
│  • isSpent() — on-chain │
│    truth for note state  │
└─────────────────────────┘
```

---

## ZK Circuits (V2)

### `circuits/withdraw_ring.circom` (new)
Proves ring membership (k=16) + global Merkle inclusion + nullifier knowledge. Decouples withdrawal timing from deposit timing. Anonymity set ≥ 300 at protocol launch (10 dummies × 30 epochs).

- **Private inputs**: `secret s`, `Merkle path for C_real`, `ring_index i`
- **Public inputs**: `ring[0..15]` (16 commitments), `nullifier N = Poseidon(s, i)`, `Merkle root R`
- **Constraint count**: ~24k (vs. ~8k in V1 — proof time ~25s in browser)

### `circuits/collateral_ring.circom` (new)
Same ring approach for borrow proofs. On-chain proof does not reveal which specific note is the collateral.

### `circuits/withdraw.circom` (V1 — retained for reference)
Full tree membership proof. Replaced by `withdraw_ring.circom` in V2. Kept in repo for comparison.

---

## Smart Contracts (V2)

| Contract | Role | ETH custody |
|----------|------|-------------|
| `ShieldedPool.sol` | Single ETH vault. Epoch batching, dummy insertion, nullifier locking, auto-settle on withdrawal. | Yes — all protocol ETH |
| `LendingPool.sol` | Accounting only. Tracks loans, interest (utilization curve), liquidation (health factor). Calls ShieldedPool via gated entry points. | No |
| `NullifierRegistry.sol` | Tracks spent nullifiers. On-chain source of truth for note state. | No |

**Vault-strategy separation:** ShieldedPool is the single point of failure for ETH — unavoidable with one vault. The separation limits LendingPool bug blast radius: its complex logic can only interact with ShieldedPool through `lockNullifier`, `disburseLoan`, `settleCollateral`. A logic exploit in LendingPool cannot arbitrarily drain ETH.

---

## Interest Rate + Liquidation (V2)

**Interest rate:** Aave v3 kinked two-slope model. Linear growth below 80% utilization, steep above.

`U ≤ 80%: rate = R_base + (U / U_optimal) × R_slope1`
`U > 80%: rate = R_base + R_slope1 + ((U - 0.8) / 0.2) × R_slope2`

Parameters: R_base=1%, R_slope1=4%, U_optimal=80%, R_slope2=40%.

**Liquidation:** Health factor = `(collateralAmount × liquidationThreshold) / totalOwed`. Liquidatable when HF < 1. Close factor: 100% (one loan per note). Liquidation bonus: 5%.

No price oracle required — collateral and borrowed asset are both ETH.

---

## Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Chain** | Base (Sepolia testnet) | EVM chain; low gas for epoch flush + dummy insertion |
| **Proof verification** | zkVerify Volta | Off-chain proof aggregation — 91% cheaper than L1 verifier |
| **Circuits** | Circom + circomlib | `withdraw_ring.circom` (k=16 ring), `collateral_ring.circom` |
| **Proof system** | Groth16 via snarkjs | WASM-compilable; browser-side proving |
| **Contracts** | Solidity + Foundry | ShieldedPool (vault), LendingPool (accounting), NullifierRegistry |
| **Stealth addresses** | ERC-5564 + `@scopelift/stealth-address-sdk` | Recipient identity unlinkability |
| **Frontend** | Next.js + wagmi + viem | SSR + wallet connect + browser WASM proof generation |

---

## V2 Implementation Plan

Implementation follows three sequential phases after this branch is approved:

**Phase 1 — Contracts:** Rewrite ShieldedPool (unified vault, epoch flush, dummies, auto-settle, depth-24 tree) and LendingPool (accounting-only, utilization curve, HF liquidation). Redeploy to Base Sepolia.

**Phase 2 — Circuits:** Write `withdraw_ring.circom` and `collateral_ring.circom`. New trusted setup (Powers of Tau reused). New `vkHash` → redeploy verifiers.

**Phase 3 — Frontend:** Note encryption (AES-256-GCM, wallet-derived key), on-load nullifier sync, withdrawal preview UI, ERC-5564 stealth address integration, ring selection wiring.

Full file-level breakdown: [`docs/v2-architecture-plan.md`](docs/v2-architecture-plan.md)

---

## Project Status

| | V1 (deployed) | V2 (this branch — not yet implemented) |
|-|---------------|----------------------------------------|
| Contracts | Live on Base Sepolia | Redesign planned (see docs/v2-architecture-plan.md) |
| ZK circuits | `withdraw.circom` + `collateral.circom` | `withdraw_ring.circom` + `collateral_ring.circom` |
| Frontend | 5-tab UI live | Note encryption, stealth addresses, ring UI |
| Tests | 57 passing | New solvency + epoch + liquidation tests planned |
| Privacy | Layer 1 (ZK proof) only | Layers 1–4 + ERC-5564 |

---

## Team

| Name | Role |
|------|------|
| Opinder Singh | Circuit design, smart contracts, zkVerify integration |
| Zuhaib | Smart contracts, Foundry testing |
| Pratham | Frontend, wagmi integration, UX |

**Cohort**: Rump Labs ZK Crypto Blockchain Cohort 1 — **Instructor**: Hridam Basu

---

## Resources

- [V2 Architecture Plan](docs/v2-architecture-plan.md) — full design specification
- [V1 State Summary](docs/v1-summary.md) — deployed contracts, tested flows
- [zkVerify Documentation](https://docs.zkverify.io/)
- [ERC-5564 Stealth Addresses](https://eips.ethereum.org/EIPS/eip-5564)
- [Circom Documentation](https://docs.circom.io/)
- [snarkjs](https://github.com/iden3/snarkjs)
- [Foundry](https://book.getfoundry.sh/)

---

## License

MIT — see [LICENSE](LICENSE)
