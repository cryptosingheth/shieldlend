# ShieldLend V2

**ZK-based private DeFi lending protocol on Base Sepolia with zkVerify proof verification.**

![Status](https://img.shields.io/badge/status-v2%20implementation%20complete-green)
![Chain](https://img.shields.io/badge/chain-Base%20Sepolia-blueviolet)
![License](https://img.shields.io/badge/license-MIT-green)
![Circuits](https://img.shields.io/badge/circuits-Circom%20%2B%20snarkjs-blue)

> **Branch `v2a-architecture`** — V2 full implementation.
> V1 was deployed and working on Base Sepolia (57 tests passing). This branch implements all three phases of the V2 redesign: new contracts (Phase 1), ring ZK circuits (Phase 2), and encrypted frontend (Phase 3).
> Design specification: [`docs/v2-architecture-plan.md`](docs/v2-architecture-plan.md) | V1 state: [`docs/v1-summary.md`](docs/v1-summary.md)

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
2. Compute commitment = Poseidon(s, n)   2. Select ring of 16 commitments from
3. Commitment queued in pendingCommitments   last 30 epochs (real + dummies mixed)
4. Every 50 blocks: flushEpoch() inserts  3. Generate ring proof in browser (WASM):
   real + dummy commitments in shuffled      - Proves ring membership (k=16)
   order using prevrandao                    - Proves global Merkle inclusion
5. Note saved to localStorage (AES-256-GCM) - Binds nullifier to ring position
   Key derived from MetaMask signature    4. Submit proof → zkVerify → attestation
                                          5. Provide ERC-5564 stealth address
BORROW                                    6. ShieldedPool verifies, sends ETH to
──────                                       stealth address
1. ZK-prove collateral note ownership        (unlinkable to deposit address)
   (collateral_ring.circom)               7. If loan open: auto-settle deducted,
2. Collateral nullifier locked on-chain      remainder to recipient
3. ETH disbursed to stealth address
4. Loan tracked in LendingPool (accounting only)
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

### `circuits/withdraw_ring.circom`
Proves ring membership (k=16) + global Merkle inclusion + nullifier knowledge. Decouples withdrawal timing from deposit timing. Anonymity set ≥ 300 at protocol launch (10 dummies × 30 epochs).

- **Private inputs**: `secret s`, `Merkle path for C_real`, `ring_index i`
- **Public inputs**: `ring[0..15]` (16 commitments), `nullifier N = Poseidon(s, i)`, `Merkle root R`
- **Constraint count**: ~24k (proof time ~25s in browser)

### `circuits/collateral_ring.circom`
Same ring approach for borrow proofs. Adds a Poseidon(3) commitment with denomination and a GreaterEqThan(96) LTV range check. On-chain proof does not reveal which specific note is the collateral.

### `circuits/withdraw.circom` (V1 — retained for reference)
Full tree membership proof. Replaced by `withdraw_ring.circom` in V2.

---

## Smart Contracts (V2)

| Contract | Role | ETH custody |
|----------|------|-------------|
| `ShieldedPool.sol` | Single ETH vault. Epoch batching, dummy insertion, nullifier locking, auto-settle on withdrawal. | Yes — all protocol ETH |
| `LendingPool.sol` | Accounting only. Tracks loans, interest (utilization curve), liquidation (health factor). Calls ShieldedPool via gated entry points. | No |
| `NullifierRegistry.sol` | Tracks spent nullifiers. On-chain source of truth for note state. | No |
| `ZkVerifyAggregation.sol` | Reads Groth16 attestation roots from zkVerify Volta chain. | No |

**Vault-strategy separation:** ShieldedPool is the single point of ETH custody. LendingPool's blast radius is limited to `lockNullifier`, `disburseLoan`, and `settleCollateral` — it cannot arbitrarily drain ETH.

---

## Security Audit — V2A Findings

Three bugs were found and fixed during the V2A pre-deployment audit. Tests in `contracts/test/SecurityAudit.t.sol` cover all three.

### Bug 1 — CRITICAL: Auto-settle proof bypass
**Severity**: Critical. Anyone who observed a `NullifierLocked` event could call `withdraw()` with that nullifier and drain ETH without knowing the note secret. The auto-settle branch ran before proof verification.

**Fix**: All proof checks (`isKnownRoot`, `isSpent`, `_verifyAttestation`) now run before the auto-settle branch.

### Bug 2 — HIGH: Wrong Merkle leaf index in events
**Severity**: High. `Deposit` event emitted the queue index, not the post-shuffle Merkle tree index. Frontend couldn't build valid proofs after epoch flush (Fisher-Yates reordering).

**Fix**: New `LeafInserted(bytes32 indexed commitment, uint32 leafIndex)` event emitted from `_insert()` with the real tree index. Frontend uses `LeafInserted` events for Merkle path construction.

### Bug 3 — HIGH: `_dummiesForEpoch()` integer underflow
**Severity**: High. Formula `nextIndex - epochNumber * DUMMIES_PER_EPOCH` underflowed once the pool grew past 200 real deposits (adaptive dummy count drops from 10 to 5).

**Fix**: New `totalDummiesInserted` state variable tracks actual dummies inserted. `_dummiesForEpoch()` uses `nextIndex - totalDummiesInserted` for the real deposit count.

---

## Interest Rate + Liquidation (V2)

**Interest rate:** Aave v3 kinked two-slope model.

```
U ≤ 80%: rate = R_base + (U / U_optimal) × R_slope1
U > 80%: rate = R_base + R_slope1 + ((U - 0.8) / 0.2) × R_slope2
```

Parameters: R_base=1%, R_slope1=4%, U_optimal=80%, R_slope2=40%.

**Liquidation:** Health factor = `(collateralAmount × liquidationThreshold) / totalOwed`. Liquidatable when HF < 1. Close factor: 100% (one active loan per note). Liquidation bonus: 5%.

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

## Implementation Status

| Phase | Component | Status |
|-------|-----------|--------|
| Phase 1 | `ShieldedPool.sol` — unified vault, epoch batching, dummy insertion, nullifier locking, auto-settle | Complete |
| Phase 1 | `LendingPool.sol` — accounting-only, utilization curve, HF liquidation | Complete |
| Phase 1 | `NullifierRegistry.sol` | Complete |
| Phase 1 | Foundry tests — 60+ passing (including SecurityAudit.t.sol regression suite) | Complete |
| Phase 2 | `withdraw_ring.circom` — k=16 ring, depth-24 Merkle | Complete |
| Phase 2 | `collateral_ring.circom` — ring + LTV range check | Complete |
| Phase 2 | Trusted setup script (`circuits/scripts/trusted_setup.sh`) | Complete (pending execution) |
| Phase 3 | Note encryption — AES-256-GCM, HKDF from MetaMask signature | Complete |
| Phase 3 | `NoteKeyContext` — session key provider | Complete |
| Phase 3 | Frontend — encrypted deposit, ring withdraw, auto-settle preview | Complete |
| Phase 3 | `NullifierRegistry` on-load sync (cross-device spent detection) | Complete |
| **Pending** | Trusted setup execution (requires `circom` + `snarkjs` CLI) | Blocked |
| **Pending** | Base Sepolia deployment | Blocked on trusted setup |
| **Pending** | ERC-5564 stealth address runtime derivation | UI wired; SDK import pending |

---

## Getting Started

### Prerequisites

```bash
node >= 18
npm install -g circom snarkjs   # for trusted setup
forge                           # https://book.getfoundry.sh/
```

### 1. Trusted Setup (one-time)

```bash
cd circuits
chmod +x scripts/trusted_setup.sh
./scripts/trusted_setup.sh
# Outputs: keys/withdraw_ring_vkey.json, keys/collateral_ring_vkey.json
# Copy the printed WITHDRAW_RING_VK_HASH into contracts/.env
```

### 2. Deploy Contracts

```bash
cd contracts
cp .env.example .env
# Fill in: PRIVATE_KEY, WITHDRAW_RING_VK_HASH
forge script script/Deploy.s.sol --broadcast --rpc-url base_sepolia
# Copy printed contract addresses into frontend/.env.local
```

### 3. Run Frontend

```bash
cd frontend
cp .env.local.example .env.local
# Fill in deployed contract addresses
npm install
npm run dev
```

---

## Environment Variables

### `contracts/.env`

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Deployer private key |
| `WITHDRAW_RING_VK_HASH` | Output of trusted setup script |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia RPC endpoint |

### `frontend/.env.local`

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SHIELDED_POOL_ADDRESS` | Deployed ShieldedPool address |
| `NEXT_PUBLIC_LENDING_POOL_ADDRESS` | Deployed LendingPool address |
| `NEXT_PUBLIC_NULLIFIER_REGISTRY_ADDRESS` | Deployed NullifierRegistry address |
| `NEXT_PUBLIC_ZKVERIFY_DOMAIN_ID` | zkVerify domain for `withdraw_ring` vkey |
| `ZKVERIFY_SEED_PHRASE` | Server-side zkVerify submission key (keep secret) |

---

## Running Tests

```bash
cd contracts
export PATH="$HOME/.foundry/bin:$PATH"
forge test -vv
# Expected: 60+ tests passing, including SecurityAudit.t.sol
```

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
