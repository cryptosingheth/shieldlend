# ShieldLend — Competitive Analysis & Architecture Research Report

*Produced: 2026-04-22 | For use during implementation planning and architecture decisions*

This document records the full competitive landscape analysis conducted before ShieldLend implementation began. It is a living reference — link to it when making architecture decisions so future contributors understand why specific patterns were chosen.

---

## 1. Purpose

Before writing implementation code, we analyzed:
1. Three GitHub projects sharing the "ShieldLend" name (different teams, different approaches)
2. Four production-grade privacy protocols with meaningful TVL (Railgun, Aztec, Nocturne, Penumbra)
3. One novel ZK credit-scoring protocol (AXIS on Aleo)
4. The Laolex/shieldlend FHE lending implementation in detail (FHE patterns directly applicable to our Encrypt FHE integration)

From this analysis we identified: architecture improvements to incorporate, vulnerabilities to fix, patterns to adopt, and where our design is genuinely novel.

---

## 2. Competitor Profiles

### 2.1 — 0xhaz/ShieldLend (Starknet)

**Chain**: Starknet (L2) | **Privacy**: Tornado Cash-style (Pedersen + Nullifiers + Merkle Tree + Noir ZK) | **Status**: Hackathon MVP

**What they built:**
- 16 Cairo modules (~3,200 LOC), 123 passing tests
- Dual-mode pool: same `LendingPool` contract handles both transparent and shielded operations via separate entry points
- Four Noir circuits: `shielded_deposit.nr`, `shielded_withdraw.nr`, `shielded_borrow.nr`, `solvency_proof.nr`
- 20-level Merkle tree with Pedersen commitments + historical root tracking
- Nullifier registry for double-spend prevention
- Dutch auction liquidations with time-decaying prices
- Yield tokenization: splits receipt tokens into principal + yield components
- Isolated markets per collateral-loan pair

**What we adopted from them:**
- Dutch auction liquidation design — time-decaying price is MEV-resistant and economically sound. Compatible with our privacy model (the LoanAccount PDA exists; auction pricing doesn't reveal borrower identity).
- Dual-mode pool concept — transparent fallback entry points within the same program aid progressive adoption and testing. Documented as future roadmap.

**Critical issues identified (not to replicate):**
- `zk_verifier.cairo` only validates proof format — ZK privacy is entirely absent until Garaga ships. We must never ship a mock verifier in any "working" form.
- Centralized admin oracle — we use Encrypt FHE encrypted oracle instead.
- `is_liquidatable()` stubbed to always return false — our three-step async liquidation with handle pinning prevents this class of bug.

---

### 2.2 — Laolex/shieldlend (Ethereum + Zama FHE)

**Chain**: Ethereum Sepolia | **Privacy**: FHE (Zama fhEVM v0.11.1) | **Status**: Advanced MVP with 78 tests

**What they built:**
- 3 Solidity contracts: `ConfidentialLending.sol`, `ConfidentialCreditScore.sol`, `ChainlinkOracle.sol`
- Overcollateralized lending with fully encrypted amounts and health factors
- Score-gated collateral ratios: 110% (Elite ≥800), 130% (Standard ≥600), 150% (Default)
- Three-step async liquidation required by FHE coprocessor decryption latency
- Keeper-based interest accrual (not triggered inside FHE context)
- Handle pinning security pattern [C-01]
- Stale liquidation flag clearing on repayment [CR-2]

**What we adopted from them (all adapted to Solana/Anchor/Encrypt FHE):**

**Handle pinning [C-01]**: Critical security pattern for any FHE-enabled liquidation. Prevents a liquidator from replaying a decryption result from one position against another. EVM implementation: `require(handlesList[0] == FHE.toBytes32(positions[borrower].isLiquidatable))`. Solana adaptation: PDA seed constraint provides the binding — Anchor's `seeds = [b"loan", nullifier_hash]` derives a unique address for each loan. The Encrypt FHE oracle verification must be signed over this PDA address.

**Three-step async liquidation**: Required because FHE decryption (like IKA threshold decryption) is asynchronous. Step 1 — request reveals a breach for a specific loan. Step 2 — Encrypt/IKA threshold decryption returns the plaintext health factor (or just "breached/not breached"). Step 3 — execute liquidation only if confirmed. This prevents liquidating solvent positions via timing attacks or replayed decryptions.

**Keeper-based interest accrual**: Interest cannot be accrued automatically inside FHE arithmetic on every transaction because doing so would trigger decryption of intermediate sums — leaking encrypted debt aggregates. An admin keeper bot calls `accrue_interest()` on a slot-based schedule. Utilization rate is estimated from public deposit counts (off-chain) and updated via governance. This is a conscious design tradeoff — document it explicitly.

**Stale liquidation flag clearing [CR-2]**: On any repayment or collateral increase, immediately clear `confirmed_liquidatable`, `pending_liquidation_reveal`, and reset `consecutive_breach_count` to zero. Prevents a race condition where position improves but old liquidation confirmation executes.

**ACL pattern**: In Encrypt FHE, intermediate computed values may require explicit access grants before the coprocessor can use them in subsequent operations. Verify Encrypt FHE Solana API for the equivalent of `FHE.allowThis()`.

---

### 2.3 — Debrajkhanra88/ShieldLend (Zama FHEVM Devnet)

**Chain**: Zama FHEVM Devnet | **Privacy**: FHE v0.4.0 | **Status**: Early prototype

**What they built:** Single 400-LOC contract with encrypted credit score formula (`score = income * 40 + history * 60 / 100`). Manual two-phase lender approval. No collateral, no health factor, no liquidation.

**Assessment**: Not a real lending protocol — a proof-of-concept for FHE credit scoring. Nothing to adopt. Serves as evidence that single-contract approaches without collateral enforcement are non-viable.

---

## 3. Production Protocol Analysis

### 3.1 — Railgun (EVM multi-chain, production)

**TVL**: $5M+/yr fees | **Privacy**: Groth16 ZK + UTXO model | **Chain**: Ethereum + Arbitrum + Optimism + Polygon

**Core mechanism:**
- UTXO-based (notes) rather than account-based. Each note: (public_key, amount, token_id, randomness) — fully encrypted.
- Single Merkle tree per chain (append-only, batch-incremental) for all tokens — all assets share one anonymity set.
- 54 ZK circuits (different input/output combinations: 1-in-2-out, 2-in-3-out, etc.) all Groth16.
- Waku P2P network for metadata-private relay submission — user IP not exposed to relay.
- AdaptRelay pattern: unshield → DeFi call → reshield, bound by a single SNARK proof covering the entire round-trip.

**Key architectural pattern adopted: Historical Merkle Root Buffer**

Railgun retains the last N Merkle roots on-chain. Users can prove their note exists against any of these historical roots — not just the current one. This is critical: if a user is offline for several epochs (VRF dummies change the root on each flush), they are not locked out permanently.

**Our implementation**: `ShieldedPoolState` stores a ring buffer of 30 roots. The ZK proof public input `root` is validated against `ring_buffer.contains(root)` rather than `root == current_root`. See `docs/architecture.md` for the updated account structure.

**Key architectural pattern adopted: Proof of Innocence (future roadmap)**

Railgun allows users to generate a ZK proof showing their deposits did not originate from OFAC-sanctioned addresses, without revealing identity. This is critical for regulatory compliance without breaking privacy. Documented as a roadmap item in our threat model — not MVP scope.

---

### 3.2 — Aztec Network (Ethereum L2, $1.5B TVL)

**Privacy**: Recursive ZK proofs + UTXO notes | **Chain**: Ethereum ZK-rollup

**Core mechanism:**
- Notes (encrypted UTXOs) held in a global Note Hash Tree (append-only).
- Nullifier Tree (separate from note hash tree) for double-spend prevention.
- Client-side recursive kernel circuits: each function call in a transaction is proved client-side, recursively.
- Three-key hierarchy: Nullifier Secret Key (nsk), Incoming Viewing Key (ivk), Signing Keys (sk). Each has different permissions. Signing keys are rotatable; nsk and ivk are not.

**Key architectural pattern adopted: App-Siloed Nullifier Keys**

Aztec's nullifier formula: `nullifier_app = Poseidon(nsk_master, app_contract_address)`. Each contract produces a different nullifier for the same note. Cross-contract nullifier correlation is impossible — if our protocol ever has a second version or complementary program, notes cannot be linked across them.

**Our implementation**: `nullifierHash = Poseidon(nullifier, SHIELDED_POOL_PROGRAM_ID)`. Added `SHIELDED_POOL_PROGRAM_ID` as a domain separator. Zero cost — one additional Poseidon input. Prevents future cross-contract deanonymization.

**Key architectural pattern (partial): Client-Side Proving**

Aztec proves each function call client-side. We already do this — ring proofs are generated entirely in the browser via snarkjs. The lesson: private inputs (secret, nullifier, ring_index, leaf_index) must never leave the browser. The IKA relay only receives the completed proof and public signals.

---

### 3.3 — Nocturne (Ethereum, $6M Series A)

**Privacy**: UTXO notes + stealth addresses + Circom ZK | **Status**: Active (Vitalik Buterin participated)

**Core mechanism:**
- Three-level key hierarchy: Spending Key (sk) → Viewing Key (vk) → Canonical Address
- Stealth address derivation: `stealth_address_i = deriveAddress(canonical_address, randomness_i)`. Anyone can generate a one-time address from recipient's canonical address without their viewing key.
- JoinSplit circuit: 2-in-2-out UTXO merge. Public: only asset type, total public spend, nullifiers, output commitments. Observer cannot determine which inputs fund which outputs.
- **Operation model**: bundles ZK proof AND DeFi instructions atomically. If any action fails, the whole operation fails — collateral never consumed without borrow disbursing.

**Key architectural pattern adopted: Atomic Borrow + Exit**

Nocturne's Operation model bundles the collateral proof AND the disbursement action in one atomic transaction. If verification succeeds but disbursement fails, the note should not be locked. Our Anchor implementation must verify the ring proof and queue the exit in the same instruction — not two separate instructions with a window between them.

**Key architectural pattern (future): JoinSplit for anonymous operation type**

Nocturne's JoinSplit circuit makes withdrawal and internal operations structurally identical (same circuit type, same proof format). Our current design uses different circuits for withdraw and borrow — an observer who sees which circuit's VK is verified can classify the operation. The JoinSplit pattern (same circuit for both) would eliminate this. Documented as future roadmap item.

---

### 3.4 — Penumbra (Cosmos privacy-native chain)

**Privacy**: Groth16 + homomorphic ElGamal threshold decryption | **Chain**: Cosmos IBC

**Core mechanism:**
- Single multi-asset shielded pool — all IBC assets share one note commitment tree + nullifier set. Maximum anonymity set from day one.
- ZSwap sealed-bid batch auction: all swaps in a block execute in one batch. Aggregated flows threshold-decrypted; individual amounts stay hidden. No intra-block MEV.
- Action model: each transaction bundles multiple actions (Output, Spend, Swap) atomically.

**Key architectural pattern adopted: Position-Dependent Nullifier Hashing**

Penumbra's nullifier formula: `nf = Poseidon(domain_separator, nullifier_key, commitment, POSITION_IN_TREE)`.

Including the leaf position prevents: if a commitment is somehow re-inserted at a different tree position, a new (different) nullifier is generated for that position. With our previous formula `Poseidon(nullifier)`, re-insertion at position 5 vs position 17 would produce the same nullifier — the double-spend prevention would function correctly, but an attacker could attempt to claim the same note is at two positions.

**Our implementation**: `nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)`. Added `leaf_index` (new private circuit input) and `SHIELDED_POOL_PROGRAM_ID` (domain separator). The circuit now also proves: `commitment` is the leaf at `leaf_index` in the Merkle tree (Merkle inclusion proof verifies both membership and position).

**Key architectural pattern adopted: Threshold Decryption for Aggregate Solvency**

Penumbra uses homomorphic ElGamal to compute validator-aggregated sums. We apply this pattern with Encrypt FHE: each encrypted loan balance contributes to a homomorphic sum, and the Encrypt threshold network decrypts only the total. Individual balances stay encrypted. The solvency check: `total_outstanding ≤ shielded_pool.lamports × LTV_FLOOR` runs on the decrypted aggregate.

---

### 3.5 — AXIS Protocol (Aleo, testnet)

**Privacy**: ZK credit scoring (Leo/Aleo circuits) | **Status**: Testnet prototype

**What they built:**
- 5-factor weighted credit score: Repayment History (35%), Position Duration (25%), Utilization Rate (20%), Protocol Loyalty (10%), Collateral Diversity (10%).
- Circuit outputs a **credit tier attestation** (Elite/Core/Entry) — not the raw score. The LTV ratio is determined by tier.
- Enables under-collateralized lending (50% collateral for Elite tier vs. 90% for Entry).

**Key concept noted for future roadmap: ZK Tier Attestation**

Instead of publishing a credit score, the circuit outputs a tier. The collateral ratio is a function of tier, not raw score. This pattern applies to our `collateral_ring.circom`: a second private input could carry a ZK proof of repayment history, allowing the circuit to certify a reduced LTV tier without revealing loan history.

**Our roadmap item**: Post-hackathon, add a `credit_tier` public output to `collateral_ring.circom`. Standard tier (first borrow): `minRatioBps = 9600`. Proven tier (1+ on-time repayments, ZK-proven): `minRatioBps = 8000`. Elite tier (3+ on-time repayments): `minRatioBps = 6500`. This enables progressively under-collateralized shielded lending — genuinely novel in the ZK lending space.

---

## 4. Vulnerabilities Identified and Fixes Applied

### V-1: Nullifier Missing Position Binding [CRITICAL — FIXED]

**Old formula**: `nullifierHash = Poseidon(nullifier)`
**New formula**: `nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)`

**Why**: (1) Position binding prevents re-insertion double-spend attacks — a note re-inserted at a different leaf position produces a different nullifier. (2) Program ID as domain separator prevents cross-contract nullifier correlation — if a second version of ShieldLend or complementary protocol exists, notes cannot be linked across them. Inspired by Penumbra's position-dependent nullifiers and Aztec's app-siloed nullifier keys.

**Circuit change**: Add `leaf_index` as private input to `withdraw_ring.circom` and `collateral_ring.circom`. The Merkle inclusion proof already verifies `commitment` is in the tree — add that it is specifically at `leaf_index`. Update nullifierHash computation to include `leaf_index` and `SHIELDED_POOL_PROGRAM_ID`.

---

### V-2: No Historical Merkle Root Buffer [CRITICAL — FIXED]

**Problem**: `ShieldedPoolState` stored only `merkle_root: [u8; 32]`. After each epoch flush (which inserts VRF dummies and updates the root), users who generated a proof against the old root would fail verification — permanently locked out if more than one epoch has passed since proof generation.

**Fix**: `ShieldedPoolState` now stores `historical_roots: [[u8; 32]; 30]` ring buffer + `root_index: u8`. The `withdraw` instruction validates `historical_roots.contains(proof.root)` instead of `proof.root == current_root`. Users have 30 epochs (~1.7 hours at 5-minute epochs) to complete a withdrawal before their root expires. Inspired by Railgun's root retention and Tornado Cash's historical root set.

---

### V-3: No Handle Pinning for FHE Liquidation [HIGH — FIXED]

**Problem**: When Encrypt FHE decrypts a health factor ciphertext for liquidation verification, nothing bound the decryption result to a specific loan account. A liquidator could theoretically submit a decryption result from one position against another.

**Fix**: `LoanAccount` PDA gains three new fields:
- `liq_ciphertext_handle: [u8; 32]` — hash of the FHE ciphertext stored at liquidation request time
- `pending_liquidation_reveal: bool` — whether a reveal is awaiting decryption
- `confirmed_liquidatable: bool` — whether decryption confirmed the position is underwater
- `consecutive_breach_count: u8` — how many consecutive oracle epochs in breach
- `breach_first_slot: u64` — slot number of first breach detection

The three-step liquidation flow uses the PDA seed constraint as the binding: since `LoanAccount` PDA is derived from `seeds = [b"loan", nullifier_hash]`, only the canonical account for that nullifier can participate in the reveal flow. The Encrypt oracle proof is verified against this PDA address. Inspired by Laolex/shieldlend's [C-01] handle pinning pattern, adapted from Solidity mapping-based to Anchor PDA-based binding.

---

### V-4: Anonymity Set Collapse for Early Protocol Users [HIGH — MITIGATED]

**Problem**: With K=16 rings and VRF dummies, early users may be in rings where most members are VRF-generated dummies. If an observer can distinguish real from dummy commitments (VRF seed is publicly verifiable), the effective ring collapses.

**Fixes implemented**:
1. `min_real_deposits_before_flush: u8 = 8` governance parameter — epoch cannot close until ≥8 real deposits. Guarantees ≥50% real ring members even at epoch boundary.
2. VRF dummy commitments must be computed as `Poseidon(vrf_output_i, denomination)` — same structure as real commitments, with VRF output serving as the "secret." The VRF output is private (only the VRF contract knows the full preimage) so dummies are cryptographically indistinguishable from real commitments on inspection.
3. Progressive ring size documented: K=8 when pool has <50 total deposits; K=16 once ≥50; K=32 once ≥200. Implemented as a circuit parameter controlled by governance.

---

### V-5: IKA FutureSign Single-Epoch Trigger [MEDIUM — MITIGATED]

**Problem**: FutureSign fires the moment FHE oracle reports a health factor breach. A single manipulated oracle price update (oracle downtime, stale feed, price spike) could trigger liquidation of a healthy position.

**Fix**: Two-epoch breach confirmation requirement. `consecutive_breach_count` in `LoanAccount` PDA increments on each oracle update that shows breach. FutureSign only activates when `consecutive_breach_count >= 2` (configurable via `breach_confirmation_epochs` governance parameter). Borrowers have one epoch to add collateral after first breach detection. Additionally: if Encrypt FHE oracle price moves more than `max_oracle_deviation_bps` (default: 2000 = 20%) between consecutive updates, new liquidations are paused for one epoch (circuit breaker).

---

### V-6: MagicBlock PER Liveness Dependency [HIGH — DOCUMENTED WITH FALLBACK]

**Problem**: If MagicBlock PER goes offline, no exits execute — neither withdrawals nor borrow disbursements. Users' funds are stuck.

**Fix**: Three-tier protocol mode defined. See `docs/NOTE_LIFECYCLE.md` for full specification. Summary:
- **Full Privacy mode** (default): all exits via PER batch, maximum privacy
- **Degraded mode** (PER offline > 5 epochs): direct ZK withdrawal without PER batching, ring anonymity preserved, temporal unlinking lost
- **Emergency mode** (PER + IKA both offline): governance-voted collateral recovery

The `per_fallback_epoch_threshold: u8 = 5` governance parameter controls mode transition. Users are notified via frontend when degraded mode is active.

---

### V-7: Borrow Amount Leaks Collateral Denomination [ACCEPTED TRADEOFF]

**Problem**: `borrowed` is a public input in `collateral_ring.circom`. Since denominations are fixed (0.1, 1, 10 SOL) and `minRatioBps` is public, an observer can infer collateral denomination: `denomination ≈ borrowed / minRatioBps × 10000`.

**Decision**: Accept as a known tradeoff. On-chain LTV verification requires `borrowed` to be public — there is no way to verify LTV without some relationship between collateral and borrow amount being publicly verifiable. Future roadmap: if full amount privacy is required, move LTV verification into Encrypt FHE space (prove `denomination ≥ borrowed × minRatioBps / 10000` homomorphically without revealing either). Not MVP scope.

**Mitigation**: Borrow amount bucketing (round to 0.1 SOL increments) reduces inference precision. Documented as a governance parameter: `min_borrow_increment_lamports`.

---

### V-8: LoanAccount PDA Creation is Observable [ACCEPTED TRADEOFF]

**Problem**: `LoanAccount` PDA creation is visible on-chain when a borrow occurs. Observers can count active loans and track approximate protocol utilization.

**Decision**: Accept as known limitation. Does not reveal borrower identity or loan amounts. Future roadmap: dummy PDAs to obscure loan count.

**In threat model**: documented as "loan count is observable; individual loan balances and borrower identities are not."

---

## 5. Architectural Patterns Not Yet Implemented (Roadmap)

| Pattern | Inspired by | Description | Priority |
|---|---|---|---|
| JoinSplit unified circuit | Nocturne | Single circuit for both withdraw and borrow ops — same circuit type prevents op-type classification | Post-hackathon |
| ZK Credit Tier Attestation | AXIS Protocol | `credit_tier` output in collateral circuit; reduced LTV for proven borrowers | Post-hackathon |
| Proof of Innocence | Railgun | ZK proof that deposits didn't originate from sanctioned addresses; regulatory compliance without identity reveal | Post-hackathon |
| IP metadata privacy | Railgun (Waku) | Route relay submissions via Waku P2P or Tor — currently user IP is visible to IKA relay | Post-hackathon |
| Dummy LoanAccount PDAs | — | Obfuscate active loan count by creating N random dummy PDAs per real borrow | Post-hackathon |
| Dual-mode pool | 0xhaz/ShieldLend | Transparent fallback entry points for progressive adoption and easier testing | Post-hackathon |

---

## 6. Market Landscape

### Active Privacy DeFi Protocols (with TVL)

| Protocol | Chain | Privacy Tech | TVL/Status |
|---|---|---|---|
| Aztec | Ethereum L2 | ZK-SNARKs, recursive kernel | $1.5B TVL (Nov 2025 mainnet) |
| Railgun | EVM multi-chain | Groth16 UTXO notes | $5M+/yr fees |
| Nocturne | Ethereum | UTXO + stealth addresses | $6M Series A |
| Hinkal | EVM | ZK, institutional | $1M TVL |
| Sienna/Secret | Secret Network | TEE smart contracts | Active |
| Penumbra | Cosmos | Threshold decryption + Groth16 | Growing |
| Aave Arc | Ethereum | Permissioned pools (KYC, not cryptographic) | 30 institutions |

### Privacy Lending on Solana

**Empty.** No production privacy lending protocol exists on Solana. The closest is Elusiv (general privacy, not lending-specific). ShieldLend occupies a unique position: ring proofs + IKA MPC relay + Encrypt FHE oracles + Umbra stealth addresses on Solana.

### Market Size

- DeFi lending TVL: ~$50B+ (Aave, Compound, Morpho)
- Privacy DeFi lending: <$50M estimated (<0.1% of total)
- Digital lending total: $507B (2025) → $985B (2031, 11.7% CAGR)
- **Implication**: privacy lending is a 0.1% wedge of a $50B+ market. Solving it well creates a new category.

---

## 7. Name Collision Analysis

Three GitHub repos share the "ShieldLend" name:
- `0xhaz/ShieldLend` (Starknet, active hackathon project)
- `Laolex/shieldlend` (Ethereum FHE, active)
- `Debrajkhanra88/ShieldLend` (Zama FHEVM, prototype)

Additionally, broader privacy DeFi naming collisions:
- `VeilFi`: 5 active repos including Arcium-based privacy lending — **avoid**
- `CipherLend`: 3 active repos, one directly overlapping — **avoid**
- `StealthFi`: 1 active repo (ZK income verification) — **avoid**
- `CloakFi`: 1 April 2026 repo — **avoid**
- `RingFi`: **CLEAR** — no DeFi projects, references core ring proof primitive
- `NullFi`: **CLEAR** — no DeFi projects, references nullifier mechanism
- `HushFi`: **CLEAR** — no matches
- `PhantomFi`: **CLEAR** — only gaming projects

**Recommendation for rename**: `RingFi` (references ring proofs — the core ZK primitive) or `NullFi` (references nullifiers — the universal ZK spend mechanism). Either is unique on GitHub and chain-agnostic.

---

## 8. References

### Protocol Documentation
- Railgun architecture: https://docs.railgun.org/wiki/learn/privacy-system
- Railgun V3 architecture: https://medium.com/@Railgun_Project/the-new-architecture-for-ethereum-privacy-introducing-railgun-v3-21e111fa297e
- Aztec keys & accounts: https://docs.aztec.network/developers/docs/foundational-topics/accounts/keys
- Aztec kernel circuits: https://docs.aztec.network/protocol-specs/circuits/private-kernel-tail
- Nocturne protocol: https://nocturne-xyz.gitbook.io/nocturne
- Penumbra protocol: https://protocol.penumbra.zone/main/
- Penumbra threshold encryption: https://protocol.penumbra.zone/main/crypto/flow-encryption/threshold-encryption.html

### Competitor Repos
- https://github.com/0xhaz/ShieldLend
- https://github.com/Laolex/shieldlend
- https://github.com/Debrajkhanra88/ShieldLend

### Laolex FHE Patterns
- Handle pinning [C-01]: `ConfidentialLending.sol::verifyLiquidationReveal()`
- Three-step liquidation: `requestLiquidationReveal` → `verifyLiquidationReveal` → `liquidate`
- Stale flag clearing [CR-2]: cleared on any `repay()` call
