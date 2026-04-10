# ShieldLend — Project Status Report

**Last updated**: 2026-04-11  
**Version**: V2B  
**Branch**: `v2a-architecture` on `cryptosingheth/shieldlend`  
**Network**: Base Sepolia (Chain ID 84532)

---

## Build Status

| Area | Status |
|------|--------|
| Smart contracts | **Deployed** — V2B (2026-04-10, block 40034191) |
| Forge test suite | **86/86 passing** |
| Live on-chain tests | **32/32 passing** (`live-test.mjs`) |
| Frontend (Next.js) | **Running** — all flows wired, dev server on port 3000 |
| ZK circuits | **Compiled** — `withdraw_ring` + `collateral_ring`, Groth16/BN254 |
| zkVerify integration | **Live** — Volta testnet, Domain ID 0 |

---

## Deployed Contracts — V2B (Current)

| Contract | Address | Notes |
|----------|---------|-------|
| ShieldedPool — Shard 1 | `0xcF78eaEA131747c67BBD1869130f0710bA646D8D` | Also `SHIELDED_POOL_ADDRESS` default |
| ShieldedPool — Shard 2 | `0x3110C104542745c55cCA31A63839F418d1354F5D` | |
| ShieldedPool — Shard 3 | `0x39769faD54c21d3D8163D9f24F63473eCC528bE0` | |
| ShieldedPool — Shard 4 | `0x02dfe4aed5Ba2A2085c80F8Fe7c20686d047111B` | |
| ShieldedPool — Shard 5 | `0xf3F7C4c1a352371eC3ae7e70387c259c7051b348` | |
| LendingPool | `0xA1d0F1A35F547698031F14fE984981632AC26240` | |
| NullifierRegistry | `0xEBC14761D4A2E30771E422F52677ed17896ec21F` | |
| ZkVerifyAggregation | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` | Shared/unchanged |
| PoseidonT3 library | `0x30F4D804AF57f405ba427dF1f90fd950C27c1Cc8` | Shared/unchanged |
| Relay wallet (deployer) | `0x6D4b038B3345acb06B8fDCA1bEAC24c731A44Fb2` | Server-side deposit relay |

**VK Hash (withdraw_ring circuit)**: `0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572`  
**Deploy block**: `40034191`

---

## Feature Completeness

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| A | Stealth withdrawal addresses (ERC-5564) | **Complete** | Fresh address per withdrawal, no on-chain history |
| B | Server-side deposit relay | **Complete** | User wallet never appears in any on-chain tx |
| C | Auditor viewing keys | **Partial** | Key derivation done (`viewingKeyContext.tsx`); UI recovery page not built |
| D | On-chain encrypted notes (Deposit event) | **Complete** | Binary-packed AES-GCM, 100B under 256B cap |
| E | CREATE2 shard factory (5 shards) | **Complete** | 20% blast radius, protocol obfuscation |
| V2B | Cross-shard withdrawal | **Complete** | Deposit shard X → withdrawal from random shard Y |

---

## End-to-End Flow Status

| Flow | Status | Verified |
|------|--------|---------|
| Deposit (server relay → random shard) | **Working** | Live-tested, block explorer confirmed |
| Epoch flush (`flushEpoch()`) | **Working** | Auto-triggered in WithdrawForm |
| Withdraw (cross-shard V2B, stealth address, zkVerify) | **Working** | Live-tested end-to-end |
| Borrow (collateral ZK proof, LendingPool) | **Wired** | NOT yet live-tested |
| Repay | **Wired** | NOT yet live-tested end-to-end |
| Liquidation | **Wired** | NOT yet live-tested |
| Auto-settle on withdrawal (cross-shard) | **Working** | Unit tested (86/86), logic verified |
| Note recovery from chain (viewing key) | **Not built** | Feature D stores notes; no recovery UI |

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| **V1** | 2026-03-28 | Tornado Cash-style pool, on-chain Groth16 verifier, no lending |
| **V2A** (Sessions 1–4) | 2026-04-03–07 | Full protocol rebuild: K=16 ring circuit, zkVerify aggregation, LendingPool, epoch batching, AES note encryption |
| **V2A+** (Session 6) | 2026-04-09 | Privacy features A–E: stealth addresses, relay, viewing keys, on-chain notes, 5-shard CREATE2 factory. 3-round security audit, 14 fixes |
| **V2B** (Session 7) | 2026-04-10–11 | Cross-shard withdrawal (deposit X → withdraw Y), binary note packing, multi-shard log scanning, 5 bugs fixed, live-test 32/32 |

---

## Security Summary

| Metric | Value |
|--------|-------|
| Total bugs found (all sessions) | 48 |
| Bugs fixed | 46 |
| Open (accepted, not fixed) | 2 |
| Audit rounds completed | 4 (Sessions 1, 4, 6, 7) |
| Critical findings | 4 — all fixed |
| High findings | 12 — all fixed |
| Medium findings | 9 — 7 fixed, 2 accepted |
| Low/Informational | 23 — most fixed or acknowledged |

**2 accepted open findings:**
1. **R3-H3** — ZkVerify aggregation operator is immutable. Accepted for testnet. Requires multisig + timelock before mainnet.
2. **R3-M2** — `block.prevrandao` used for Fisher-Yates shuffle. Biased by L2 sequencer. Requires Chainlink VRF + circuit change to fix. Accepted for testnet.

Full detail: `AUDIT_REPORT.md`

---

## Architecture Summary

```
User Browser
  │
  ├── DepositForm ──► POST /api/deposit (server relay)
  │                       │
  │                       └──► ShieldedPool[random shard] .deposit(commitment, encryptedNote)
  │                               │
  │                               ├── Queued in pendingCommitments[]
  │                               └── After 50 blocks: flushEpoch() shuffles + inserts into Merkle tree
  │                                       │
  │                                       └── LeafInserted event → frontend reconstructs Merkle path
  │
  ├── WithdrawForm
  │   ├── Scans all 5 shards for commitment (getAllLogsAllShards)
  │   ├── Fetches Merkle path from depositShard
  │   ├── Generates Groth16 proof (withdraw_ring.wasm + .zkey) in browser
  │   ├── Submits proof to zkVerify Volta → receives aggregation ID
  │   ├── Picks random withdrawalShard ≠ depositShard (V2B)
  │   └── Calls withdrawalShard.withdraw(root, nullifierHash, stealthAddress, ...)
  │
  ├── BorrowForm
  │   ├── Generates collateral_ring proof in browser
  │   ├── Submits to zkVerify → aggregation ID
  │   └── Calls LendingPool.borrow(nullifierHash, amount, collateralShard, disburseShard)
  │
  └── RepayForm
      └── Calls LendingPool.repay{value: totalOwed}(loanId)

LendingPool (accounting-only, no ETH custody)
  ├── Loan struct: collateralNullifierHash, collateralShard, disburseShard, borrowed, timestamp
  ├── isValidRoot: global Merkle root registry (all 5 shards push roots here)
  └── hasActiveLoan(nullifierHash): global collateral check for cross-shard settlement

NullifierRegistry (shared across all 5 shards)
  └── Prevents double-spend across shards
```

---

## Key Technical Parameters

| Parameter | Value |
|-----------|-------|
| Merkle tree depth | 24 (2^24 = 16.7M leaves) |
| Ring size | K = 16 |
| Epoch length | 50 blocks (~100s on Base) |
| Adaptive dummies | 10/epoch (pool <200 deposits), 5/epoch (≥200) |
| Denominations | 0.05 ETH, 0.1 ETH, 0.5 ETH |
| Note encryption | AES-256-GCM, 72B binary pack → 100B ciphertext |
| Proof system | Groth16 / BN254, off-chain via zkVerify |
| Number of shards | 5 (CREATE2 factory) |
| Blast radius per shard | ~20% of TVL |

---

## Repository Structure

```
shieldlend-v2/
├── contracts/
│   ├── src/
│   │   ├── ShieldedPool.sol          — deposit, withdraw, epoch batching, Merkle tree
│   │   ├── LendingPool.sol           — borrow, repay, liquidate, auto-settle
│   │   ├── NullifierRegistry.sol     — shared nullifier tracking across all shards
│   │   ├── ZkVerifyAggregation.sol   — on-chain aggregation root registry
│   │   └── ShieldedPoolFactory.sol   — CREATE2 deploy of 5 shards
│   ├── test/
│   │   ├── ShieldedPool.t.sol        — 33 unit tests
│   │   ├── LendingPoolTest.t.sol     — 35 unit tests
│   │   ├── SecurityAudit.t.sol       — 10 regression tests (3 critical bugs)
│   │   └── GasTest.t.sol             — 8 gas benchmarks
│   └── script/
│       ├── DeployV2B.s.sol           — current production deploy script
│       ├── DeployV2A.s.sol           — V2A deploy (superseded)
│       └── DeployLendingPool.s.sol   — standalone LendingPool deploy
├── circuits/
│   ├── withdraw_ring.circom          — K=16 ring proof, depth-24 Merkle inclusion
│   ├── collateral_ring.circom        — K=16 ring proof, LTV guard, no nullifier spend
│   └── scripts/trusted_setup.sh     — automated Powers of Tau + phase 2 ceremony
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── api/deposit/route.ts  — server relay (Feature B)
│   │   │   └── api/zkverify/route.ts — zkVerify proof submission
│   │   ├── components/
│   │   │   ├── DepositForm.tsx
│   │   │   ├── WithdrawForm.tsx      — cross-shard routing, stealth address
│   │   │   ├── BorrowForm.tsx
│   │   │   ├── RepayForm.tsx
│   │   │   └── History.tsx
│   │   └── lib/
│   │       ├── noteStorage.ts        — AES-256-GCM note persistence
│   │       ├── noteKeyContext.tsx    — HKDF note key from MetaMask signature
│   │       ├── stealthKeyContext.tsx — ERC-5564 stealth key derivation
│   │       ├── viewingKeyContext.tsx — auditor viewing key (separate HKDF chain)
│   │       └── contracts.ts         — viem contract hooks, ALL_SHARD_ADDRESSES
│   └── public/circuits/
│       ├── withdraw_ring.wasm        — circuit for browser proving
│       └── collateral_ring.wasm      — circuit for browser proving
├── docs/                             — architecture, tech stack, user guide
├── ARCHITECTURE_DECISIONS.md         — 25 ADRs, full design rationale
├── AUDIT_REPORT.md                   — all 48 bugs, 4 audit rounds
├── STATUS_REPORT.md                  — this file
├── ROADMAP.md                        — future work
├── README.md                         — project overview
└── CLAUDE.md                         — Claude Code project instructions (auto-ADR updates)
```

---

## Setup for New Team Members

```bash
# 1. Clone and install
git clone https://github.com/cryptosingheth/shieldlend.git
cd shieldlend
git checkout v2a-architecture

# 2. Install Foundry (if not present)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 3. Install forge dependencies
cd contracts && forge install

# 4. Run test suite (should be 86/86)
forge test

# 5. Frontend
cd ../frontend && npm install
# Create frontend/.env.local — see CLAUDE.md for required variables
npm run dev

# 6. Circuit proving keys (.zkey files — gitignored due to size)
# Either run circuits/scripts/trusted_setup.sh to generate, or obtain from team
# Place at: frontend/public/circuits/withdraw_ring.zkey
#            frontend/public/circuits/collateral_ring.zkey

# 7. Live test (requires .env.local with DEPLOYER_PRIVATE_KEY)
node frontend/live-test.mjs
```

---

## Pending Work

| Priority | Task | Effort |
|----------|------|--------|
| High | Live-test borrow + repay flows end-to-end on Base Sepolia | 1 session |
| High | Viewing key recovery UI — scan chain, decrypt with viewing key (Feature C frontend) | 1 session |
| Medium | Replace ZkVerify aggregation operator with multisig + timelock (pre-mainnet) | 1 session |
| Medium | Consider Chainlink VRF for Fisher-Yates shuffle (removes sequencer bias) | 2 sessions |
| Low | Auto-forward ETH from stealth address to MetaMask (UX improvement) | 0.5 session |
| Low | Add new denominations (1 ETH, 10 ETH) — requires circuit recompile + redeploy | 1 session |
| Future | Mainnet deployment (Base mainnet) | Requires: multisig operator, final audit, VRF |

---

*Generated 2026-04-11. Auto-updated by Claude Code at end of each session.*
