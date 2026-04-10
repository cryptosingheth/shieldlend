# ShieldLend V2A — Private DeFi Lending on Base Sepolia

**Branch**: `v2a-architecture` | **Network**: Base Sepolia (chain ID 84532) | **Status**: Active development

ShieldLend is a privacy-first lending protocol. Users deposit ETH into a shielded pool, borrow against collateral without revealing their identity, and withdraw to fresh cryptographic addresses. No on-chain linkage between depositor and borrower/withdrawer.

---

## What Makes ShieldLend Private

ShieldLend has five active privacy layers and five more in active development (V2A+):

### Current Privacy Layers (V2A — deployed)

| Layer | Mechanism | What It Hides |
|-------|-----------|---------------|
| 1. Browser | In-browser ring proof generation; AES-256-GCM note encryption | Note contents never leave device |
| 2. ZK Circuits | Ring proof K=16 across last 30 epochs; Poseidon nullifier | Which commitment is being withdrawn (1-in-16 ring) |
| 3. Smart Contracts | Single vault, accounting-only lending; nullifier locking; auto-settle | Loan amount + recipient hidden from event logs |
| 4. zkVerify | Off-chain Groth16 verification (Volta testnet); single-leaf aggregation | Proof computation off main chain |
| 5. Epoch Batching | 50-block queue + Fisher-Yates shuffle + adaptive dummy commitments | Timing correlation between deposit and withdrawal |

### Planned Privacy Features (V2A+)

| Feature | Mechanism | Status |
|---------|-----------|--------|
| A. Stealth withdrawal addresses | ERC-5564 per-withdrawal fresh address (ECDH, `@scopelift/stealth-address-sdk`) | Planned |
| B. Server-side deposit relay | Next.js API route submits deposit on behalf of user | Planned |
| C. Auditor viewing keys | Separate AES-256-GCM key for selective note disclosure | Planned |
| D. Zcash-style on-chain encrypted notes | `bytes encryptedNote` stored in Deposit event | Planned |
| E. CREATE2 shard factory + cross-shard withdrawal | 5 independent shard contracts; global root registry enables cross-shard proofs | Planned |

See [`docs/privacy-architecture.md`](docs/privacy-architecture.md) for the full design.

---

## Evolution: V1 → V2A → V2A+

```
V1 (single note Merkle proof, variable amounts, flat rate)
 ↓
V2A (K=16 ring, epoch batching, fixed denominations, Aave v3 interest, HF liquidation)
 ↓
V2A+ (stealth addresses, deposit relay, viewing keys, encrypted notes, CREATE2 sharding,
       cross-shard withdrawal — novel: all shards share same vkHash → proofs are fungible
       across shards without circuit change)
```

---

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full system diagram and data flows.

**Smart contracts:**
- `ShieldedPool.sol` — single ETH vault; epoch batching; ZK withdrawal verification
- `LendingPool.sol` — accounting-only; Aave v3 two-slope interest; health factor liquidation
- `NullifierRegistry.sol` — global nullifier spend registry
- `ZkVerifyAggregation.sol` — zkVerify on-chain aggregation verification

**Circuits:**
- `withdraw_ring.circom` — K=16 ring membership + depth-24 Merkle inclusion + nullifier binding
- `collateral_ring.circom` — same structure; proves collateral ownership for borrow

---

## Deployed Contracts — Base Sepolia (current V2A deployment)

| Contract | Address |
|----------|---------|
| ShieldedPool | `0x9365e995F8aF1051db68100677a6C9cf225055A9` |
| LendingPool | `0x1aacF59792404b23287Faa9b0fbC3c9505cc56c9` |
| NullifierRegistry | `0xD0e7D0A083544144a4EFf2ADAa6318E3a28722e7` |
| ZkVerifyAggregation | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` |

zkVerify network: Volta testnet | Domain ID: 0

---

## Running Locally

```bash
# Install dependencies
cd frontend && npm install

# Start dev server
npm run dev
# -> http://localhost:3000

# Environment variables required (create frontend/.env.local):
DEPLOYER_PRIVATE_KEY=0x...
ZKVERIFY_SEED_PHRASE=...
NEXT_PUBLIC_SHIELDED_POOL_ADDRESS=0x9365e995F8aF1051db68100677a6C9cf225055A9
NEXT_PUBLIC_LENDING_POOL_ADDRESS=0x1aacF59792404b23287Faa9b0fbC3c9505cc56c9
NEXT_PUBLIC_NULLIFIER_REGISTRY_ADDRESS=0xD0e7D0A083544144a4EFf2ADAa6318E3a28722e7
ZKVERIFY_AGGREGATION_ADDRESS=0x8b722840538d9101bfd8c1c228fb704fbe47f460
```

---

## End-to-End Status

| Flow | Status |
|------|--------|
| Deposit → flushEpoch → Withdraw | Confirmed live |
| Borrow | Frontend wired, ZK circuits compiled, not yet live-tested |
| Repay | Auto-discovered loan dropdown, not yet live-tested |

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/architecture.md`](docs/architecture.md) | System diagram, data flows, smart contract ABIs |
| [`docs/privacy-architecture.md`](docs/privacy-architecture.md) | Complete privacy model — current layers + V2A+ plan |
| [`docs/circuits.md`](docs/circuits.md) | ZK circuit design, public inputs, commitment formula |
| [`docs/tech-stack.md`](docs/tech-stack.md) | Technology choices and rationale |
| [`docs/verification.md`](docs/verification.md) | ZK verification flow, zkVerify integration |
| [`AUDIT_REPORT.md`](AUDIT_REPORT.md) | 27 documented security findings; H-1/H-3 fixed |
| [`ROADMAP.md`](ROADMAP.md) | Build history and upcoming milestones |
