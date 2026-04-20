# ShieldLend — Privacy-First Lending Protocol on Solana

A zero-knowledge, privacy-preserving lending protocol on Solana. Every transaction layer is private by design: deposits are unlinkable to wallets, withdrawal destinations are one-time addresses, loan amounts are encrypted on-chain, and the signing infrastructure has no single operator key.

Built for the **Colosseum Frontier Hackathon 2026**.

---

## The Problem

On-chain lending has a fundamental privacy problem — and it is not just about hiding amounts.

Every interaction with a lending protocol creates a permanent, public record that an observer can use to build a profile of a user:

| Observable data | What it reveals |
|---|---|
| Deposit transaction | Depositor's wallet, amount, and timing |
| Loan disbursement | Borrower's wallet, loan size, and collateral |
| Repayment transaction | Confirmation that a wallet is a borrower |
| Withdrawal | Links the depositor's wallet to a withdrawal destination |

This matters for individuals who want financial privacy, for institutions that cannot reveal their treasury positions on-chain, and for anyone whose on-chain credit history should not be public record.

Existing privacy tools address one layer at a time: mixers hide amounts but not identities; stealth addresses hide destinations but not deposits; ZK proofs hide which commitment was spent but not who authorized the relay. ShieldLend addresses all four layers simultaneously.

---

## Design Philosophy

Privacy in DeFi is not a feature — it is a stack.

A protocol that hides withdrawal destinations but not deposit origins is broken. A protocol that encrypts balances but leaves signing keys exposed to a single operator is broken. ShieldLend treats each privacy dimension as an independent layer, designed so that each layer holds even if another is weakened:

- **Execution privacy** (Layer 1 — MagicBlock PER): *Who* deposited is hidden. Deposits execute inside an Intel TDX enclave. No observer can link a user's wallet to a specific commitment in the pool.
- **Authorization privacy** (Layer 2 — IKA dWallet): *Who authorized* each operation is hidden behind 2PC-MPC. No single operator key exists. Loan disbursements require both program-gated LTV validation AND IKA MPC consensus.
- **Data privacy** (Layer 3 — Encrypt FHE): *How much* was borrowed is hidden. Loan balances and interest are stored as FHE ciphertext accounts. Interest accrues homomorphically — validators compute on encrypted values.
- **Address privacy** (Layer 4 — Umbra SDK): *Where* funds went is hidden. Every output — withdrawal destinations and loan disbursements — routes to a one-time Umbra stealth address with no prior chain history.

Defense-in-depth: if any single layer is analyzed, the others still protect the user.

---

## Protocol Selection

Every protocol in ShieldLend's stack was chosen to close a specific privacy gap that no other tool addressed. The design started from privacy requirements and worked backwards to protocols — not the other way around.

The component-to-protocol mapping tables below show this gap → choice relationship for every function in the protocol. For the full decision rationale (alternatives considered, tradeoffs evaluated), see [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md).

---

## Architecture

ShieldLend is four independent privacy layers over a single Anchor program core.

```
┌─────────────────────────────────────────────────────────────┐
│  USER INTERFACE (Next.js + snarkjs + Umbra SDK)             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  LAYER 4 — ADDRESS PRIVACY                                  │
│  Umbra SDK                                                  │
│  All outputs (withdrawals, loan disbursements) route to     │
│  one-time stealth addresses. Auto-forwarded to user.        │
│  Address abandoned after single use.                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  LAYER 3 — DATA PRIVACY                                     │
│  Encrypt FHE                                                │
│  Loan balances and interest stored as FHE ciphertext        │
│  accounts. Interest computed on encrypted values.           │
│  Threshold decryption for auditor disclosure.               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  LAYER 2 — AUTHORIZATION PRIVACY                            │
│  IKA dWallet                                                │
│  Protocol relay uses 2PC-MPC dWallet. Disbursements         │
│  require both on-chain program approval (LTV check)         │
│  and IKA MPC network consensus. No single operator key.     │
│  FutureSign enables trustless pre-authorized liquidation.   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  LAYER 1 — EXECUTION PRIVACY                                │
│  MagicBlock Private Ephemeral Rollup + VRF + Session Keys  │
│  Deposits execute inside Intel TDX enclave. VRF-randomized  │
│  dummy insertions enlarge the anonymity set. Session Keys   │
│  authorize once; secondary operations run automatically.    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  CORE PROGRAMS                                              │
│  shielded_pool · lending_pool (Kamino fork) ·               │
│  nullifier_registry                                         │
│  groth16-solana · Poseidon hash · Anchor PDAs               │
└─────────────────────────────────────────────────────────────┘
```

---

## How Unlinkability Is Achieved

### Deposit

The user's wallet never appears in the ShieldedPool deposit transaction.

1. User generates a commitment client-side: `commitment = Poseidon(secret, nullifier, denomination)`. Secret and nullifier never leave the browser.
2. User sends SOL to the IKA relay address (TX1 — visible, but only shows funding of relay).
3. The IKA dWallet program batches this deposit with others inside a **MagicBlock Private Ephemeral Rollup** (Intel TDX enclave). The batch processes privately.
4. PER commits a batch of commitments to ShieldedPool (TX2 — signer is the IKA relay program, not the user). TX1 and TX2 are not one-to-one.
5. VRF-randomized dummy commitments are inserted alongside real ones, enlarging the anonymity set.

Observer sees TX1: "User funded relay." Observer sees TX2: "Relay deposited batch to pool." No linking between them.

### Withdrawal

No observer can connect the depositor's wallet to the withdrawal destination.

1. User loads their note (secret + nullifier) from the local encrypted vault.
2. `snarkjs` generates a **Groth16 ring proof**: proves ownership of one commitment in a ring of 16, without revealing which one.
3. `groth16-solana` verifies the proof on-chain (< 200k compute units).
4. SOL is released to a fresh **Umbra stealth address** — a one-time address with zero prior chain history.
5. **Umbra SDK** derives the private key for the stealth address and sweeps to the user's wallet. The stealth address is abandoned.

The ring proof hides *which* commitment was spent. The stealth address hides *where* the funds went.

### Borrow

The collateral identity and the borrower's wallet are never linked.

1. User selects a committed note as collateral.
2. `snarkjs` generates a **Groth16 collateral proof**: proves ring membership + denomination ≥ borrowed × LTV floor — entirely in-circuit, no amounts revealed to validators.
3. `groth16-solana` verifies the proof on-chain.
4. The **IKA dWallet** receives an `approve_message()` CPI from the LendingPool program. The program validates LTV; the IKA MPC network (2/3 consensus) co-signs the disbursement. No private key exists.
5. Loan proceeds go to a fresh **Umbra stealth address**, which auto-forwards to the borrower.
6. **Encrypt FHE**: loan balance and accrued interest recorded as ciphertext accounts.

No observer links "this commitment is locked as collateral" to "this wallet received a loan."

### Repay

Repayment does not reveal the borrower's identity.

1. User generates a **repay_ring proof**: proves knowledge of the collateral nullifier + `repaymentAmount ≥ totalOwed`. The borrower's wallet is a private input — never revealed.
2. SOL goes via the IKA relay (indistinguishable from deposit relay traffic).
3. `groth16-solana` verifies the repay proof on-chain.
4. IKA dWallet co-signs collateral unlock.
5. Loan PDA cleared, nullifier unlocked. Collateral note is ready for withdrawal.

---

## Funds and Accounting

```
ShieldedPool program         — holds ALL SOL; Poseidon Merkle tree (depth 24)
        ↕ CPI
LendingPool program          — accounting only; NO SOL; Kamino klend fork
        ↕ CPI
NullifierRegistry program    — PDA-based spent nullifier set; shared
```

SOL flows:
- **Deposit**: IKA relay → ShieldedPool (CPI)
- **Withdraw**: ShieldedPool → Umbra stealth address
- **Borrow**: ShieldedPool → Umbra stealth address (triggered by LendingPool CPI)
- **Repay**: IKA relay → ShieldedPool; LendingPool clears loan PDA

---

## ZK Circuits

All circuits produce Groth16 proofs verified on-chain by `groth16-solana`.

| Circuit | Proves | Public outputs |
|---|---|---|
| `withdraw_ring.circom` | Ring membership (K=16) + Merkle inclusion (depth 24) | `ring[16]`, `nullifierHash`, `root`, `denomination_out` |
| `collateral_ring.circom` | Ring membership + `denomination × minRatioBps ≥ borrowed × 10000` | `ring[16]`, `nullifierHash`, `root`, `borrowed`, `minRatioBps` |
| `repay_ring.circom` | Knowledge of collateral nullifier + `repaymentAmount ≥ totalOwed` | `nullifierHash`, `loanId` |

---

## Fixed Denominations

Deposits use fixed denominations (0.1 SOL, 1 SOL, 10 SOL). This is a requirement of the ZK circuit design: denomination is embedded in the commitment hash and is a public output of the withdrawal proof. Standardized denominations prevent amount-based correlation — every participant in a denomination pool looks identical on-chain.

Loan amounts are variable and hidden via Encrypt FHE ciphertext accounts.

---

## Protocol Solvency — Aggregate Without Individual Exposure

ShieldLend maintains continuous solvency guarantees without revealing individual loan positions.

**Aggregate monitoring (always-on):** Encrypt FHE executor performs homomorphic addition across all encrypted loan balances:
```
total_outstanding = Σ(encrypted_loan_balance[i])   // FHE addition on ciphertexts
```
Threshold decryption reveals ONLY the aggregate total. Individual amounts stay hidden. The MagicBlock ER liquidation bot verifies: `total_outstanding ≤ shielded_pool.lamports × LTV_floor` continuously.

**Targeted audit (on-demand):** For compliance disclosure of a specific loan, threshold decryption reveals that one account's balance to the auditor. Borrower identity is not revealed — only the amount.

---

## Umbra Payroll Integration

Users receiving private payroll via Umbra can deposit directly into ShieldLend without breaking the privacy chain:

```
Employer → Umbra.sendToStealthAddress(employeeMetaAddress, SOL)
         → Salary arrives at one-time stealth address
Employee → Umbra SDK sweeps to ShieldLend deposit relay
         → ShieldLend deposit flow: commitment generated, note saved locally
         → Earns yield on pooled SOL
         → Can borrow against deposited collateral

Result: Employer never sees where salary was allocated.
        ShieldLend never sees the payroll origin.
        Privacy chain intact end-to-end.
```

---

## Component → Protocol Mapping

### ShieldedPool

| Function | Protocol | Why this protocol |
|---|---|---|
| Deposit batching + execution | MagicBlock PER (TEE) | Intel TDX enclave required to batch multiple users' deposits without any single party observing the deposit→commitment mapping |
| Anonymity set expansion | MagicBlock VRF | Dummy insertions must be cryptographically unbiasable — a pseudorandom shuffle is gameable by a patient adversary; VRF provides per-shuffle on-chain verifiable randomness |
| Withdrawal authorization | groth16-solana | Groth16 ring proof must be verified on-chain atomically with fund release; groth16-solana uses BN254 native syscalls (<200k CU) making on-chain verification feasible |
| Withdrawal recipient | Umbra SDK | Withdrawal destination must be a one-time address with zero prior chain history; Umbra SDK handles stealth address generation, key derivation, and auto-sweep |
| Session UX | MagicBlock Session Keys | Single wallet authorization per session; auto-sweep and secondary operations (dummy insertion monitoring, note reveal) run without repeated wallet prompts |
| Post-commit automation | MagicBlock Magic Actions | When PER commits to base Solana, stealth address sweep must trigger automatically without a separate user transaction; Magic Actions fires this deterministically |

### LendingPool

| Function | Protocol | Why this protocol |
|---|---|---|
| Interest rate model | Kamino klend fork | Poly-linear 11-point model (more granular than two-slope) from a $3.2B TVL production protocol; audited; directly applicable to fixed-denomination lending |
| Collateral proof verification | groth16-solana | Collateral ring proof contains the LTV check as a public circuit output — must verify on-chain before loan disbursement; same BN254 syscall path as withdraw |
| Repayment proof verification | groth16-solana | repay_ring proof hides borrower wallet; on-chain verification required to safely clear the loan PDA |
| Disbursement signing | IKA dWallet | Loan disbursement must require consent from BOTH the program (LTV validated) AND an external party (anti-abuse). IKA 2PC-MPC means neither party alone can sign — no single operator key risk |
| Disbursement recipient | Umbra SDK | Borrower's receiving address must be a stealth address for the same reason as withdrawals — linking borrower wallet to disbursement destination would break identity privacy |
| Balance + interest storage | Encrypt FHE | Loan balances and interest on-chain must be hidden from validators and block explorers; Encrypt stores them as ciphertext accounts that compute interest homomorphically |
| Health factor computation | Encrypt FHE (encrypted oracle) | If price feeds are submitted in plaintext, observers can front-run liquidations; Encrypt oracle submits prices as FHE ciphertext so health_factor is computed on encrypted values |
| Auditor disclosure | Encrypt threshold decryption | Individual loan disclosure for compliance requires revealing one account without blanket exposure; threshold decryption (2/3 MPC) is minimal-disclosure by construction |
| Liquidation pre-authorization | IKA FutureSign | Liquidation consent from the borrower must be captured at borrow time and executed trustlessly when health_factor is breached — no operator should be trusted to trigger this |
| Liquidation monitoring | MagicBlock ER (non-private) | Health factor polling must run at 1ms to prevent MEV manipulation of liquidation timing; ER runs sub-millisecond health checks without privacy overhead |
| Protocol upgrade path | IKA ReEncryptShare | Admin key transfer (DAO governance) without requiring IKA MPC to reshare secrets; future-facing, deferred to post-mainnet |

---

## Privacy Guarantee Summary

| Threat | Mitigation | Protocol |
|---|---|---|
| Depositor wallet visible in pool tx | IKA relay + PER batching | IKA + MagicBlock PER |
| Timing correlation (deposit→pool) | PER batches multiple users; TX1 and TX2 are not one-to-one | MagicBlock PER |
| Anonymity set too small | VRF dummy insertions expand Merkle tree | MagicBlock VRF |
| Withdrawal linked to deposit | Ring proof (K=16): observer cannot identify which commitment was spent | Circom |
| Withdrawal destination known | Umbra stealth address: one-time, no prior history | Umbra SDK |
| Loan amount on-chain | Encrypt FHE ciphertext accounts | Encrypt |
| Health factor front-running | Encrypted oracle input; health_factor computed on ciphertext | Encrypt FHE |
| Borrower wallet linked to loan | Umbra stealth disbursement address | Umbra SDK |
| Repayer identity revealed | repay_ring ZK proof hides wallet; relayed via IKA | Circom + IKA |
| Single operator key risk | IKA 2PC-MPC (2/3 consensus; user always required) | IKA |
| Liquidation trust | IKA FutureSign (pre-signed consent; not operator-controlled) | IKA |
| Double-spend | NullifierRegistry PDA + ZK nullifierHash | ZK + Anchor |

---

## Tech Stack

**On-Chain**
- Anchor (Rust smart contracts)
- Kamino klend fork (lending logic)
- groth16-solana (ZK proof verification, BN254 native syscalls, Light Protocol Labs)
- MagicBlock PER macros (`#[ephemeral]`, `#[delegate]`, `#[commit]`)
- MagicBlock VRF SDK
- MagicBlock Session Keys program
- IKA dWallet Anchor CPI (`ika-dwallet-anchor`)
- Encrypt FHE Anchor integration (`encrypt-anchor`)
- Poseidon hash (matching circuits)

**Off-Chain / Client**
- snarkjs 0.7.4 (Groth16 browser proof generation, ~1.2s)
- Circom (withdraw_ring, collateral_ring, repay_ring)
- Umbra SDK (TypeScript, stealthaddress.dev)
- AES-256-GCM + HKDF (client-side note vault, from wallet signature)
- Next.js 14 + React 18
- @solana/wallet-adapter + @solana/web3.js

---

## Repository Structure

```
shieldlend-solana/
├── programs/
│   ├── shielded_pool/          # deposit, withdraw, Merkle tree, VRF integration
│   ├── lending_pool/           # Kamino klend fork + IKA + Encrypt FHE wiring
│   └── nullifier_registry/     # PDA nullifier set
├── circuits/
│   ├── withdraw_ring.circom    # K=16 ring + depth-24 Merkle
│   ├── collateral_ring.circom  # K=16 ring + LTV in-circuit
│   ├── repay_ring.circom       # nullifier knowledge + repayment >= totalOwed
│   └── keys/                   # .zkey + .vkey.json for all three circuits
├── tests/
│   ├── shielded_pool.ts
│   ├── lending_pool.ts
│   └── live-test.mjs           # E2E devnet
├── frontend/
│   ├── app/
│   │   └── api/
│   │       ├── ika/route.ts    # IKA dWallet approve_message endpoint
│   │       └── per/route.ts    # MagicBlock PER deposit endpoint
│   ├── lib/
│   │   ├── circuits.ts         # snarkjs proof generation
│   │   ├── umbra.ts            # Umbra SDK integration (ALL stealth addresses)
│   │   ├── encrypt.ts          # Encrypt FHE ciphertext interaction
│   │   └── noteStorage.ts      # AES-256-GCM localStorage vault
│   └── components/
│       ├── DepositForm.tsx
│       ├── WithdrawForm.tsx
│       ├── BorrowForm.tsx
│       └── RepayForm.tsx
├── docs/
│   ├── ARCHITECTURE.md         # Deep technical architecture and program design
│   ├── PRIVACY_MODEL.md        # Threat model and unlinkability analysis
│   ├── DESIGN_DECISIONS.md     # Protocol selection rationale for every component
│   └── HACKATHON.md            # Track eligibility and submission narratives
├── Anchor.toml
├── Cargo.toml
├── package.json
└── README.md
```

---

## Hackathon Tracks

| Track | Sponsor | ShieldLend implements |
|---|---|---|
| IKA + Encrypt Frontier | Superteam | dWallet relay + FutureSign + FHE ciphertext accounts + encrypted oracle |
| Colosseum Privacy Track | MagicBlock | PER deposit batching + VRF shuffle + Session Keys + Magic Actions + ER liquidation |
| Umbra Side Track | Frontier | Umbra SDK powers all output addresses; payroll integration use case |

These tracks address orthogonal privacy dimensions — no overlap, fully complementary.

---

## Pre-Alpha Status

Several protocols used in ShieldLend are in pre-alpha on devnet. Hackathon integration uses mock signers / unencrypted fallbacks. Production deployments require mainnet availability.

| Protocol | Devnet status | Production path |
|---|---|---|
| IKA dWallet | Pre-alpha (mock signer) | IKA Solana mainnet |
| Encrypt FHE | Pre-alpha (plaintext fallback) | Encrypt mainnet + IKA network |
| MagicBlock PER | Devnet (Discord access required) | MagicBlock PER mainnet |
| groth16-solana | Mainnet-beta ready | BN254 syscalls live since Solana 1.18.x |
| Umbra SDK | Mainnet alpha (Solana, Feb 2026) | Production-ready |

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Program design, CPI flows, account model, data structures |
| [`docs/PRIVACY_MODEL.md`](docs/PRIVACY_MODEL.md) | Threat model, attack classes, unlinkability proofs per flow |
| [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md) | Protocol selection rationale — privacy requirement → protocol choice |
| [`docs/HACKATHON.md`](docs/HACKATHON.md) | Track-by-track eligibility, submission narratives, required integrations |

---

## Getting Started

```bash
# Solana CLI + Anchor prerequisites
solana-install init 1.18.x
anchor --version  # 0.30.x

# Install frontend dependencies
cd frontend && npm install

# Join MagicBlock Discord for PER devnet endpoint access
# https://discord.com/invite/MBkdC3gxcv

# Configure environment
cp frontend/.env.example frontend/.env.local
# Set: IKA_DWALLET_*, MAGICBLOCK_PER_ENDPOINT, UMBRA_*, SOLANA_RPC_URL
```
