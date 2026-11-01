# ShieldLend V2B — Private DeFi Lending on Base Sepolia

**Version**: V2B (cross-shard withdrawal) | **Network**: Base Sepolia (chain ID 84532) | **Status**: Testnet pre-alpha — not audited, not for real funds

ShieldLend is a privacy-first lending protocol. Users deposit ETH into a shielded pool, borrow against collateral without revealing their identity, and withdraw to fresh cryptographic addresses. No on-chain linkage between depositor and borrower/withdrawer.

---

## What Makes ShieldLend Private

### Core Privacy Layers

| Layer | Mechanism | What It Hides |
|-------|-----------|---------------|
| 1. Browser | In-browser ring proof generation; AES-256-GCM note encryption | Note contents never leave device |
| 2. ZK Circuits | Ring proof K=16 across last 30 epochs; Poseidon nullifier | Which commitment is being withdrawn (1-in-16 ring) |
| 3. Smart Contracts | Accounting-only lending; nullifier locking; auto-settle | Loan amount + recipient hidden from event logs |
| 4. zkVerify | Off-chain Groth16 verification (Volta testnet); only the aggregation root is posted to Base | Proof computation off main chain |
| 5. Epoch Batching | 50-block queue + Fisher-Yates shuffle + adaptive dummy commitments | Timing correlation between deposit and withdrawal |

### V2A+ / V2B Privacy Features

| Feature | Mechanism | Status |
|---------|-----------|--------|
| A. Stealth withdrawal addresses | ERC-5564 per-withdrawal fresh address (`@scopelift/stealth-address-sdk`), auto-forward to the user's wallet | Implemented for withdraw + borrow |
| B. Server-side deposit relay | Next.js API route submits the deposit, so the user's wallet never calls the pool | Implemented |
| C. Auditor viewing keys | Separate AES-256-GCM key for selective note disclosure | Key context implemented; recovery UI not built |
| D. On-chain encrypted notes | 72-byte binary-packed encrypted note emitted in the `Deposit` event | Implemented, verified live |
| E. Sharding + cross-shard withdrawal | 5 shard pools share one circuit and vkHash, so a proof is valid on every shard: deposit on shard X, withdraw from random shard Y | Implemented, verified live |

See [`docs/privacy-architecture.md`](docs/privacy-architecture.md) for the design and [`ARCHITECTURE_DECISIONS.md`](ARCHITECTURE_DECISIONS.md) for the 31 ADRs behind it.

---

## Evolution: V1 → V2A → V2A+ → V2B

```
V1 (single note Merkle proof, variable amounts, flat rate)
 ↓
V2A (K=16 ring, epoch batching, fixed denominations, Aave v3 interest, HF liquidation)
 ↓
V2A+ (stealth addresses, deposit relay, viewing keys, encrypted notes, CREATE2 sharding)
 ↓
V2B (cross-shard withdrawal and borrow disbursement — all shards share the same vkHash,
     so proofs are fungible across shards without a circuit change)
```

---

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full system diagram and data flows.

**Smart contracts:**
- `ShieldedPool.sol` — ETH vault with epoch batching and ZK withdrawal verification; deployed as 5 shards
- `LendingPool.sol` — accounting-only (never holds ETH); Aave v3 two-slope interest; health factor liquidation
- `NullifierRegistry.sol` — global nullifier spend registry shared by all shards
- `ZkVerifyAggregation.sol` — zkVerify on-chain aggregation verification

**Circuits:**
- `withdraw_ring.circom` — K=16 ring membership + depth-24 Merkle inclusion + nullifier binding
- `collateral_ring.circom` — same structure; proves collateral ownership for borrow

---

## Deployed Contracts — Base Sepolia (V2B, 2026-04-10)

| Contract | Address |
|----------|---------|
| Shard 1 (`SHIELDED_POOL_ADDRESS`) | `0xcF78eaEA131747c67BBD1869130f0710bA646D8D` |
| Shard 2 | `0x3110C104542745c55cCA31A63839F418d1354F5D` |
| Shard 3 | `0x39769faD54c21d3D8163D9f24F63473eCC528bE0` |
| Shard 4 | `0x02dfe4aed5Ba2A2085c80F8Fe7c20686d047111B` |
| Shard 5 | `0xf3F7C4c1a352371eC3ae7e70387c259c7051b348` |
| LendingPool | `0xA1d0F1A35F547698031F14fE984981632AC26240` |
| NullifierRegistry | `0xEBC14761D4A2E30771E422F52677ed17896ec21F` |
| ZkVerifyAggregation | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` |

zkVerify network: Volta testnet | Domain ID: 0 | withdraw_ring vkHash: `0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572`

---

## Running Locally

```bash
# Contracts — 86 Foundry tests
cd contracts
forge install foundry-rs/forge-std --no-commit
forge install iden3/poseidon-solidity --no-commit
forge test

# Frontend — proving keys and circuit WASM ship in frontend/public/circuits
cd frontend
npm ci        # frontend/.npmrc sets legacy-peer-deps
npm run dev   # -> http://localhost:3000
```

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_SHIELDED_POOL_ADDRESS=0xcF78eaEA131747c67BBD1869130f0710bA646D8D
NEXT_PUBLIC_SHARD_1=0xcF78eaEA131747c67BBD1869130f0710bA646D8D
NEXT_PUBLIC_SHARD_2=0x3110C104542745c55cCA31A63839F418d1354F5D
NEXT_PUBLIC_SHARD_3=0x39769faD54c21d3D8163D9f24F63473eCC528bE0
NEXT_PUBLIC_SHARD_4=0x02dfe4aed5Ba2A2085c80F8Fe7c20686d047111B
NEXT_PUBLIC_SHARD_5=0xf3F7C4c1a352371eC3ae7e70387c259c7051b348
NEXT_PUBLIC_LENDING_POOL_ADDRESS=0xA1d0F1A35F547698031F14fE984981632AC26240
NEXT_PUBLIC_NULLIFIER_REGISTRY_ADDRESS=0xEBC14761D4A2E30771E422F52677ed17896ec21F
NEXT_PUBLIC_RELAY_ADDRESS=<relay wallet address>
ZKVERIFY_AGGREGATION_ADDRESS=0x8b722840538d9101bfd8c1c228fb704fbe47f460
DEPLOYER_PRIVATE_KEY=0x...   # relay wallet; server-side only
ZKVERIFY_SEED_PHRASE=...     # zkVerify Volta account; server-side only
```

Live on-chain check against the deployment (32 checks, makes one 0.001 ETH test deposit):

```bash
DEPLOYER_PRIVATE_KEY=0x... node frontend/live-test.mjs
```

---

## End-to-End Status

| Area | Status |
|------|--------|
| Contract test suite | 86/86 passing |
| Live deployment checks (`live-test.mjs`) | 32/32 passing on Base Sepolia |
| Frontend production build | Passing |
| Deposit → epoch flush → ZK ring withdraw | Confirmed live in browser |
| Stealth auto-forward after withdraw/borrow | Code-complete (Base L1 data-fee reserve fix); browser re-test pending |
| Borrow → repay | Frontend + API wired; not yet confirmed end-to-end in browser |
| Viewing-key recovery page | Not built |

**Known limitations (accepted for testnet):**
- zkVerify and LendingPool operator is a single EOA — needs a multisig before mainnet
- Shard shuffle is `keccak256`-seeded, not Chainlink VRF
- Repaying from the user's wallet reveals that the wallet had a loan (not which note or depositor)
- Groth16 keys come from a local development setup, not a public multi-party ceremony
- Security review is internal only — no external audit

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/architecture.md`](docs/architecture.md) | System diagram, data flows, smart contract ABIs |
| [`docs/privacy-architecture.md`](docs/privacy-architecture.md) | Complete privacy model |
| [`docs/circuits.md`](docs/circuits.md) | ZK circuit design, public inputs, commitment formula |
| [`docs/tech-stack.md`](docs/tech-stack.md) | Technology choices and rationale |
| [`docs/verification.md`](docs/verification.md) | ZK verification flow, zkVerify integration |
| [`ARCHITECTURE_DECISIONS.md`](ARCHITECTURE_DECISIONS.md) | ADR-01 to ADR-31 |
| [`AUDIT_REPORT.md`](AUDIT_REPORT.md) | Internal security review findings and fixes |
| [`SESSION_LOGS/`](SESSION_LOGS/) | Dated build log for every development session |
| [`ROADMAP.md`](ROADMAP.md) | Build history and upcoming milestones |
