# ShieldLend

**ZK-based private DeFi lending protocol on Horizen L3 (Base) with zkVerify proof verification.**

![Status](https://img.shields.io/badge/status-in%20development-yellow)
![Chain](https://img.shields.io/badge/chain-Horizen%20L3%20on%20Base-blueviolet)
![License](https://img.shields.io/badge/license-MIT-green)
![Circuits](https://img.shields.io/badge/circuits-Circom%20%2B%20snarkjs-blue)

---

## The Problem

Every action on a public DeFi lending protocol is fully transparent. When you deposit collateral, borrow against it, or repay — the exact amount, your wallet address, and your entire position are permanently visible on-chain. Anyone can track which wallets are overleveraged, target liquidations, or build a complete financial profile of any user.

DeFi doesn't have to work this way.

---

## The Solution

ShieldLend adds a ZK privacy layer to DeFi lending using the **commit → prove → reveal** pattern — the same cryptographic model that powers Tornado Cash, applied to a lending context.

Users deposit into a shielded pool using a cryptographic commitment. To withdraw, they generate a zero-knowledge proof that they know the secret behind a commitment in the pool — without revealing *which* commitment is theirs. The deposit and withdrawal are cryptographically unlinkable.

---

## How It Works

```
DEPOSIT                          WITHDRAW
────────                         ────────
1. Generate secret + nullifier   1. Load saved note (secret, nullifier)
2. Compute commitment            2. Fetch current Merkle root
   = Pedersen(amount, secret)    3. Generate Merkle path for commitment
3. Submit commitment on-chain    4. Run withdraw.circom in browser →
   → stored in Merkle tree          Groth16 proof (proves membership
4. Save your note securely          + nullifier knowledge, no amounts)
   (this is your only key)      5. Submit proof to zkVerify
                                 6. zkVerify attestation → contract
                                 7. Nullifier marked spent → funds sent
                                    (no link to original deposit address)
```

---

## Key Features

- **Private deposits** — collateral amount hidden behind a Pedersen commitment; only a hash goes on-chain
- **Unlinkable withdrawals** — Merkle membership proof + nullifier reveal; deposit and withdrawal addresses are cryptographically unlinked
- **Shielded collateral proofs** — ZK range proof proves `collateral ≥ min_ratio × borrowed` without revealing the exact collateral amount
- **Browser-side proof generation** — circuits compile to WebAssembly; users generate proofs locally, no trusted server
- **91% cheaper verification** — proofs verified via zkVerify chain instead of on-chain Ethereum L1 verifier contracts

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  USER BROWSER                                                   │
│  Next.js + wagmi + snarkjs (WASM)                               │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Deposit UI      │  │  Withdraw UI     │  │  Collateral   │  │
│  │  1. Enter amount │  │  1. Enter note   │  │  Proof UI     │  │
│  │  2. Gen secret   │  │  2. Gen Merkle   │  │               │  │
│  │  3. Compute      │  │     proof        │  │  1. Prove     │  │
│  │     commitment   │  │  3. Gen nullif.  │  │     ratio >   │  │
│  │  4. Submit tx    │  │  4. Submit proof │  │     threshold │  │
│  └──────────────────┘  └──────────────────┘  └───────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ wallet tx + proof
┌──────────────────────────────▼──────────────────────────────────┐
│  ZK CIRCUITS (Circom)                                           │
│                                                                 │
│  deposit.circom           withdraw.circom      collateral.circom│
│  ─────────────            ────────────────     ────────────────  │
│  private: amount,         private: secret,     private:         │
│    secret, nullifier        nullifier,            exact_amount  │
│  public:  commitment,       pathElements[]      public:          │
│    nullifierHash          public: root,           min_ratio,    │
│                             recipient              borrowed      │
│                           constraints:           constraints:    │
│                             Merkle member.        amount*100 ≥  │
│                             + nullifier            ratio*borrowed│
└──────────────────────────────┬──────────────────────────────────┘
                               │ Groth16 proof
              ┌────────────────┴────────────────┐
              │                                 │
┌─────────────▼──────────────┐  ┌──────────────▼──────────────┐
│  SMART CONTRACTS           │  │  ZKVERIFY CHAIN             │
│  (Solidity on Horizen L3)  │  │                             │
│                            │  │  1. Receive proof via       │
│  ShieldedPool.sol          │  │     zkVerifyJS SDK          │
│  • Incremental Merkle tree │  │  2. Verify Groth16 proof    │
│  • insertCommitment()      │  │     (91% cheaper than L1)   │
│  • getRoot()               │  │  3. Emit attestation event  │
│                            │  │  4. Relayer reads event     │
│  NullifierRegistry.sol     │  │     → calls ShieldedPool    │
│  • mapping: null→bool      │  └─────────────────────────────┘
│  • markSpent(nullifier)    │
│  • isSpent(nullifier)      │
│                            │
│  LendingPool.sol           │
│  • Forked from Aave V3     │
│  • deposit(commitment)     │
│  • borrow(proof, amount)   │
│  • repay()                 │
│  • withdraw(proof)         │
└────────────────────────────┘

Deployment: Horizen L3 on Base (testnet) — fallback: Base Sepolia
```

---

## Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Chain** | Horizen L3 on Base | EVM-native L3, privacy-first execution environment |
| **Proof verification** | zkVerify | Modular proof verification — 91% cheaper than L1 |
| **Circuits** | Circom + circomlib | ZK-SNARK circuit language; Pedersen, Poseidon, Merkle templates |
| **Proof system** | Groth16 via snarkjs | 3-pairing verification; 192-byte proof; WASM-compilable |
| **Contracts** | Solidity + Foundry | ShieldedPool, NullifierRegistry, LendingPool (Aave V3 fork) |
| **Frontend** | Next.js + wagmi | SSR + wallet connection + browser WASM proof generation |

See [`docs/tech-stack.md`](docs/tech-stack.md) for detailed rationale on every choice.

---

## ZK Circuits

Three circuits handle the privacy layer. All compile to WebAssembly for browser-side proving.

### `circuits/deposit.circom`
Proves that a commitment was correctly computed from a secret and amount.
- **Private inputs**: `amount`, `secret`, `nullifier`
- **Public outputs**: `commitment = Pedersen(amount || secret)`, `nullifierHash = Poseidon(nullifier)`

### `circuits/withdraw.circom`
Proves Merkle membership (the commitment is in the tree) and nullifier knowledge (the prover knows the secret), without revealing which leaf or how much.
- **Private inputs**: `secret`, `nullifier`, `pathElements[]`, `pathIndices[]`
- **Public inputs**: `root` (current Merkle root), `recipient` (withdrawal address)
- **Public outputs**: `nullifierHash`

### `circuits/collateral.circom`
Proves that collateral meets the minimum ratio requirement without revealing the exact collateral amount.
- **Private inputs**: `exact_collateral_amount`
- **Public inputs**: `min_ratio`, `borrowed_amount`
- **Constraint**: `exact_collateral * 100 >= min_ratio * borrowed_amount`

See [`docs/circuits.md`](docs/circuits.md) for full signal definitions and constraint derivations.

See [`docs/verification.md`](docs/verification.md) for Groth16 vs zkVerify verification, regenerating proofs (`scripts/gen_test_proofs.js`), and Foundry verifier tests.

---

## Smart Contracts

| Contract | Purpose |
|----------|---------|
| `ShieldedPool.sol` | Maintains the incremental Merkle tree of commitments. Handles `deposit()` and `withdraw()`. Verifies zkVerify attestation before releasing funds. |
| `NullifierRegistry.sol` | Tracks spent nullifier hashes. Prevents double-withdrawal. Called by ShieldedPool on every withdrawal. |
| `LendingPool.sol` | Minimal Aave V3 fork. Adds `borrow()` and `repay()` on top of the shielded pool, using collateral range proofs to gate borrowing without revealing positions. |

See [`docs/architecture.md`](docs/architecture.md) for full interface definitions and data flow diagrams.

---

## Project Roadmap

| Step | Task | Key Output |
|------|------|-----------|
| **0** | Design complete — architecture, circuits, contracts scoped | This repo |
| **1** | Scaffold: `forge init` + Circom project structure + Next.js frontend | Project skeleton |
| **2** | `deposit.circom` — Pedersen commit(amount, secret, nullifier) | Working deposit circuit |
| **3** | `withdraw.circom` — Merkle membership + nullifier reveal | Working withdraw circuit |
| **4** | Trusted setup: Powers of Tau → per-circuit `.zkey` | Proving keys |
| **5** | Deploy ShieldedPool.sol + NullifierRegistry.sol on Horizen L3 | Live contracts |
| **6** | Integrate zkVerifyJS SDK — submit proof, receive attestation | Working proof pipeline |
| **7** | Frontend: MetaMask connect, browser WASM proof generation | Working UI |
| **8** | Fork minimal Aave V3 pool — collateral/borrow mechanics | LendingPool.sol |
| **9** | `collateral.circom` — range proof (collateral ratio ≥ threshold) | Collateral circuit |
| **10** | End-to-end tests + testnet deploy + demo | Deployed MVP |

See [`ROADMAP.md`](ROADMAP.md) for detailed phase descriptions and deliverables.

---

## Competitive Landscape

| Project | Approach | Outcome | Lesson |
|---------|----------|---------|--------|
| Sacred Finance | Tornado Cash + Aave yield, on Ethereum | Launched, low adoption | Proves the pattern works. We improve with zkVerify (cheaper) + Horizen L3 |
| Aztec Connect | Full privacy L2 rollup over Ethereum | Shut down March 2023 | Full-stack privacy L2 is too complex. Feature-level privacy (our approach) is the right scope. |
| zkFi | Academic multi-asset privacy pool, Ethereum | Research stage | Circuit architecture reference. Their paper is a design input for withdraw.circom. |
| Zkredit | MPC-based private lending, Solana | Building | Chose MPC because ZK was "too slow on Solana". zkVerify removes this constraint on EVM. |

**ShieldLend's angle**: proven pattern (Sacred Finance / Tornado Cash) + proven lending mechanic (Aave V3) + novel stack (Horizen L3 + zkVerify — not tried before on this chain combination).

---

## Team

| Name | Role |
|------|------|
| Opinder Singh | Circuit design, smart contracts, zkVerify integration |
| Zuhaib | Smart contracts, Foundry testing |
| Pratham | Frontend, wagmi integration, UX |

**Cohort**: Rump Labs ZK Crypto Blockchain Cohort 1
**Instructor**: Hridam Basu

---

## Getting Started

> Setup instructions will be added as we complete the project scaffold (Step 1).
> Follow the repo to be notified when the development environment setup is ready.

---

## Resources

- [zkVerify Documentation](https://docs.zkverify.io/)
- [zkVerifyJS SDK Tutorial](https://docs.zkverify.io/tutorials/complete-tutorials/zkverify-js)
- [Horizen L3 on Base](https://www.horizen.io/)
- [Circom Documentation](https://docs.circom.io/)
- [snarkjs](https://github.com/iden3/snarkjs)
- [circomlib (Pedersen, Poseidon templates)](https://github.com/iden3/circomlib)
- [Foundry](https://book.getfoundry.sh/)
- [zkFi Paper (circuit architecture reference)](https://arxiv.org/html/2307.00521v4)

---

## License

MIT — see [LICENSE](LICENSE)
