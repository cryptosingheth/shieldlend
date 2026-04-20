# ShieldLend Solana — Project Claude Instructions

## What This Project Is

ShieldLend is a **privacy-first lending protocol on Solana**, targeting the Colosseum Frontier Hackathon 2026.

- **Repo**: `cryptosingheth/shieldlend`, branch `shieldlend-solana`
- **Local worktree**: `/Users/opinderpreetsingh/shieldlend-solana` (always on `shieldlend-solana`)
- **EVM version** (separate, do not touch): `/Users/opinderpreetsingh/shieldlend-v2` on branch `v2a-architecture`
- **Git email**: always verify `git config user.email` = `opinderpreet@gmail.com` before first commit
- **Never add Co-Authored-By trailers. Never open a PR unless explicitly asked.**

---

## Hackathon Tracks (Colosseum Frontier 2026)

| Track | Sponsor | What ShieldLend implements |
|---|---|---|
| IKA + Encrypt Frontier | Superteam | dWallet relay + FutureSign + FHE ciphertext accounts + encrypted oracle |
| Colosseum Privacy Track | MagicBlock | PER deposit batching + VRF shuffle + Session Keys + Magic Actions + ER liquidation |
| Umbra Side Track | Frontier | Umbra SDK for all output addresses + payroll integration |

Three orthogonal privacy layers — no overlap between tracks.

---

## Current State (as of 2026-04-20)

### Done
- `README.md` — full Solana architecture with 4-layer privacy diagram, unlinkability flows, protocol mapping
- `docs/architecture.md` — Anchor program designs, account models, CPI flows, ZK circuit specs
- `docs/PRIVACY_MODEL.md` — threat model, unlinkability analysis per flow, trust assumptions
- `docs/DESIGN_DECISIONS.md` — ADR-style rationale for every protocol choice
- `docs/HACKATHON.md` — track-by-track integration descriptions (no prize amounts)
- `circuits/withdraw_ring.circom` — K=16 ring, depth-24 Merkle (reused from EVM, chain-agnostic)
- `circuits/collateral_ring.circom` — LTV check in-circuit (reused from EVM, chain-agnostic)
- `frontend/public/circuits/withdraw_ring.wasm` — compiled wasm for browser snarkjs
- `frontend/public/circuits/collateral_ring.wasm` — compiled wasm for browser snarkjs
- `frontend/src/lib/circuits.ts` — snarkjs proof generation (chain-agnostic, reused)
- `frontend/src/lib/noteStorage.ts` — AES-256-GCM note vault (chain-agnostic, reused)
- `frontend/tailwind.config.ts`, `tsconfig.json`, `postcss.config.js` — framework config

### Not Yet Built
- `circuits/repay_ring.circom` — new circuit (proves nullifier knowledge + repayment ≥ totalOwed)
- Anchor workspace (`Anchor.toml`, `Cargo.toml`)
- `programs/shielded_pool/` — Anchor program
- `programs/lending_pool/` — Kamino klend fork
- `programs/nullifier_registry/` — PDA nullifier set
- `frontend/` — Solana frontend (wagmi/viem replaced with @solana/wallet-adapter)
- `frontend/lib/umbra.ts` — Umbra SDK integration
- `frontend/lib/encrypt.ts` — Encrypt FHE ciphertext interaction
- `frontend/app/api/ika/route.ts` — IKA dWallet approve_message endpoint
- `frontend/app/api/per/route.ts` — MagicBlock PER deposit endpoint
- Tests

---

## Architecture Overview

### Four Privacy Layers
1. **Execution** (MagicBlock PER) — deposits batched in Intel TDX enclave; user wallet never in ShieldedPool tx
2. **Authorization** (IKA dWallet) — no single operator key; 2PC-MPC for relay + disbursements
3. **Data** (Encrypt FHE) — loan balances and interest as ciphertext accounts
4. **Address** (Umbra SDK) — all outputs route to one-time stealth addresses

### Program Structure
```
shielded_pool   — holds ALL SOL; Merkle tree (depth 24, Poseidon); VRF epoch flush
      ↕ CPI
lending_pool    — accounting only, NO SOL; Kamino klend interest model
      ↕ CPI
nullifier_registry — PDA per nullifier_hash; shared by both programs
```

### ZK Circuits (all Groth16, verified by groth16-solana)
| Circuit | Status | Public outputs |
|---|---|---|
| `withdraw_ring.circom` | Done (reused) | ring[16], nullifierHash, root, denomination_out |
| `collateral_ring.circom` | Done (reused) | ring[16], nullifierHash, root, borrowed, minRatioBps |
| `repay_ring.circom` | TODO | nullifierHash, loanId |

### Commitment Formula (unchanged from EVM)
```
commitment = Poseidon(secret, nullifier, denomination)
nullifierHash = Poseidon(nullifier)
```

### Fixed Denominations (0.1 SOL, 1 SOL, 10 SOL)
Required by circuit design — denomination is embedded in commitment and is a PUBLIC output of the withdraw proof. Cannot be made variable without breaking ZK. Loan amounts are separate and variable (hidden by Encrypt FHE).

---

## Protocol Stack — Complete Mapping

### shielded_pool
| Function | Protocol | Why |
|---|---|---|
| Deposit batching | MagicBlock PER (`#[ephemeral]`, `#[delegate]`, `#[commit]`) | Intel TDX enclave; no user→commitment linkage |
| Dummy insertion randomness | MagicBlock VRF SDK | Cryptographically unbiasable; proof per result |
| Withdrawal verification | groth16-solana | Atomic on-chain Groth16; BN254 native syscalls; <200k CU |
| Withdrawal recipient | Umbra SDK | One-time stealth address; auto-sweep; abandoned after use |
| Session UX | MagicBlock Session Keys | Authorize once; secondary ops automatic |
| Post-commit sweep | MagicBlock Magic Actions | Auto-trigger Umbra sweep on PER commit |

### lending_pool
| Function | Protocol | Why |
|---|---|---|
| Interest rate | Kamino klend fork | $3.2B TVL, audited, poly-linear 11-point, Anchor-native |
| Collateral + repay verification | groth16-solana | Same BN254 path as withdraw |
| Disbursement signing | IKA dWallet (`approve_message()` CPI) | No private key; 2PC-MPC; user + IKA MPC both required |
| Disbursement recipient | Umbra SDK | Fresh stealth address per loan |
| Balance + interest storage | Encrypt FHE (`encrypt-anchor`) | Ciphertext accounts; homomorphic interest accrual |
| Health factor | Encrypt FHE encrypted oracle | Prevents oracle front-running |
| Aggregate solvency | Encrypt FHE homomorphic sum | Σ(encrypted balances) → single threshold decrypt |
| Targeted audit | Encrypt threshold decryption | 2/3 MPC; one account revealed; no blanket exposure |
| Liquidation pre-auth | IKA FutureSign | Pre-signed at borrow time; executes when HF breached |
| Liquidation monitoring | MagicBlock ER | 1ms health checks; MEV-resistant |

---

## Technical Invariants (DO NOT BREAK)

1. **Commitment formula**: `Poseidon(secret, nullifier, denomination)` — all three inputs, this order
2. **Nullifier formula**: `Poseidon(nullifier)` — single input
3. **Ring size**: K=16 for both withdraw and collateral circuits
4. **Merkle depth**: 24 (supports 16M leaves)
5. **BN254 field size**: `21888242871839275222246405745257275088548364400416034343698204186575808495617`
6. **lending_pool holds NO SOL** — all SOL custody is in shielded_pool
7. **All stealth addresses via Umbra SDK** — do not use a custom ECDH implementation
8. **IKA dWallet required for ALL relay signing** — no fallback to a server private key
9. **groth16-solana for ALL proof verification** — not a remote service, must be atomic on-chain
10. **Encrypt FHE for loan balance storage** — do not store amounts in plaintext PDAs

---

## Pre-Alpha Status (Important for Implementation)

| Protocol | Devnet status | Hackathon approach |
|---|---|---|
| IKA dWallet | Pre-alpha (mock signer) | Use mock signer; document production path |
| Encrypt FHE | Pre-alpha (plaintext fallback) | Plaintext fallback with FHE interface stubs |
| MagicBlock PER | Devnet (Discord access required) | Join discord.com/invite/MBkdC3gxcv first |
| groth16-solana | Mainnet-beta ready | Full production integration |
| Umbra SDK | Solana mainnet alpha (Feb 2026) | Full production integration |
| Kamino klend | Production ($3.2B TVL) | Fork and adapt |

---

## Implementation Phases

### Phase 1 — Core Programs (start here)
1. `anchor init` in `/Users/opinderpreetsingh/shieldlend-solana`
2. Scaffold: `shielded_pool`, `lending_pool`, `nullifier_registry`
3. Define account structs (ShieldedPoolState, CommitmentAccount, LoanAccount, NullifierAccount)
4. Implement instruction signatures (no logic yet)
5. Wire `groth16-solana` into `withdraw` and `borrow` instructions

### Phase 2 — repay_ring.circom
1. Write `circuits/repay_ring.circom`
2. Private inputs: `nullifier`, `repaymentAmount`, `borrowerWallet`
3. Public outputs: `nullifierHash = Poseidon(nullifier)`, `loanId`
4. `circom repay_ring.circom --r1cs --wasm --sym`
5. `snarkjs groth16 setup` → `.zkey` → export `_vkey.json`
6. Copy wasm + zkey to `frontend/public/circuits/`

### Phase 3 — Privacy Protocol Integrations
- Umbra SDK: `frontend/lib/umbra.ts`
- MagicBlock VRF: `shielded_pool::flush_epoch`
- MagicBlock Session Keys: frontend auth flow
- MagicBlock Magic Actions: post-PER-commit sweep trigger
- MagicBlock PER: `#[ephemeral]` + `#[delegate]` on deposit queue accounts
- MagicBlock ER: health monitor delegation + liquidation bot
- IKA dWallet: `approve_message()` CPI for relay + disbursement + repay
- IKA FutureSign: pre-signed liquidation consent at borrow time
- Encrypt FHE: ciphertext loan accounts + encrypted oracle + aggregate solvency

### Phase 4 — Frontend
- Port `@solana/wallet-adapter` + `@solana/web3.js`
- Wire DepositForm, WithdrawForm, BorrowForm, RepayForm to Anchor programs
- Add Umbra payroll → ShieldLend deposit flow

### Phase 5 — E2E Test + Submission
- `live-test.mjs` against Solana devnet
- Submit all three tracks

---

## Auto-Update Rule

After every session where architecture decisions are made or programs are modified:
1. Append a new ADR entry to `docs/DESIGN_DECISIONS.md` (same format as existing entries)
2. Update the "Current State" section in this file
3. Commit with `docs:` prefix before pushing

---

## Git Conventions
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- Never amend unless explicitly asked
- Never add Co-Authored-By trailers
- Never push without explicit instruction
- Never open a PR unless explicitly asked
- Stage specific files only — never `git add -A`
