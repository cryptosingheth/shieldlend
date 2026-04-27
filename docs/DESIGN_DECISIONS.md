# ShieldLend — Design Decisions

Every protocol and component choice in ShieldLend answers a specific privacy or security requirement. This document records what was required, what was considered, and why the chosen approach was selected.

---

## Smart Contract Framework: Anchor (not Bolt)

**Requirement**: A Solana smart contract framework that supports MagicBlock's PER/VRF macros.

**Options considered**:
- **Bolt (MagicBlock's ECS framework)**: Extends Anchor with Entity-Component-System patterns. Optimized for gaming (entity positions, velocity, health bars). Introduces ECS abstractions (World, Entity, Component) that add overhead with no benefit for financial state machines.
- **Anchor (plain)**: MagicBlock's `#[ephemeral]`, `#[delegate]`, `#[commit]`, and VRF SDK all work directly with plain Anchor macros. No ECS layer needed.

**Decision**: Plain Anchor. Bolt's ECS pattern adds complexity for a financial protocol whose state is account mappings and PDAs, not game entities.

---

## Lending Logic: Kamino klend Fork (not Aave v3 port)

**Requirement**: A production-quality, audited lending interest rate model that runs on Solana.

**Options considered**:
- **Aave v3 two-slope model**: Well-known, widely used. Two kink points — base rate below optimal, jump rate above optimal. Solidity implementation not portable directly; requires full rewrite.
- **Custom flat rate**: Simple but inaccurate — cannot price risk differentiation at varying utilization levels.
- **Kamino klend (Anchor, open source)**: Poly-linear 11-point model directly from a $3.2B TVL production Solana protocol. Already Anchor-compatible. Audited. More granular than two-slope — rate can be tuned at 11 utilization levels to match market conditions precisely.

**Decision**: Kamino klend fork. It is purpose-built for Solana, audited, and operationally proven at scale. The 11-point poly-linear model gives finer rate control than a two-slope port. The rate history stored on-chain also enables the ZK repayment sufficiency circuit — see ADR: Repayment Sufficiency below.

---

## ZK Proof Verification: groth16-solana (not zkVerify / not custom verifier)

**Requirement**: On-chain Groth16 proof verification for withdraw_ring, collateral_ring, and repay_ring circuits. Must be atomic with the state change it gates (withdrawal, borrow, repay) — no round-trip to an external service.

**Options considered**:
- **zkVerify (Horizen Labs Volta testnet)**: Off-chain aggregation service. Proof submitted to zkVerify, aggregated root posted to destination chain. Requires two transactions (submit proof → receive aggregation root → call contract). Introduces a round-trip latency window where state could change between proof generation and on-chain validation.
- **Custom BN254 verifier in Rust**: Possible but requires implementing pairing checks manually. High implementation risk, unaudited.
- **groth16-solana (Light Protocol Labs)**: Purpose-built Groth16 verifier for Solana. Uses BN254 native syscalls added to Solana 1.18.x (mainnet-beta). Under 200k compute units per verification. Audited. Compatible with circom-generated proving keys and snarkjs proofs.

**Decision**: groth16-solana. Atomic on-chain verification eliminates the round-trip window. BN254 native syscalls make it computationally feasible within Solana's compute budget. The Light Protocol audit provides security assurance without a custom implementation.

---

## ZK Circuits: Circom + Groth16 (unchanged from EVM version)

**Requirement**: ZK circuits for ring membership + Merkle inclusion + LTV checks.

**Groth16 vs PLONK vs STARKs**:
- **Groth16**: Smallest proofs (~200 bytes), fastest browser verification (~1.2s with snarkjs), smallest on-chain verification cost. Requires per-circuit trusted setup (Powers of Tau ceremony). Three circuits at current scale is manageable.
- **PLONK**: Universal trusted setup (one setup for all circuits). Larger proofs. No recursion needed in ShieldLend — the universal setup advantage does not apply.
- **STARKs**: No trusted setup, post-quantum secure. Proof sizes too large for browser generation at practical speed. Verifier cost higher than BN254 Groth16.

**Circom vs other DSLs (Noir, Leo)**:
- Circom: mature, large community, snarkjs compatibility, existing circuits tested and correct. No migration benefit.
- Noir: newer, more ergonomic. Would require rewriting all three circuits without a correctness track record for this specific application.

**Decision**: Circom + Groth16, unchanged. The circuits are chain-agnostic — commitment formula, ring structure, and Merkle depth are independent of the settlement layer.

---

## Deposit Relay: IKA dWallet + MagicBlock PER (not server-side relay)

**Requirement**: The user's wallet must not appear in the ShieldedPool deposit transaction. Timing correlation between a user's funding transaction and the resulting commitment must be eliminated.

**Options considered**:
- **Server-side relay (Next.js API route with private key)**: Relayer holds a private key. Single point of failure — compromise of the server compromises all relay operations. The relayer can censor, front-run, or selectively include deposits.
- **IKA dWallet relay alone**: No private key exists. The relay wallet is a 2PC-MPC dWallet — every operation requires both user partial signature AND IKA MPC network co-signature. Eliminates operator key risk. Does not address timing correlation — each deposit still produces a 1:1 relay→pool transaction.
- **IKA dWallet relay + MagicBlock PER batching**: Deposits are queued in an Intel TDX enclave before committing to Solana. Multiple users' deposits are batched into a single TX2. The enclave cannot be read from outside — even the PER operator cannot link individual users to their commitments within the batch.

**Decision**: IKA dWallet for relay signing (eliminates operator key risk) + MagicBlock PER for batching (eliminates timing correlation). These address different attack surfaces: IKA handles signing trust; PER handles temporal batch isolation. Both are required.

The PER also handles the exit batch (see ADR: Unified Exit Path below) — the same enclave environment covers both deposit inputs and SOL outputs.

---

## Withdrawal Submission: IKA Relay (not direct user submission)

**Requirement**: The withdrawal ring proof transaction must not reveal the user's wallet as the on-chain signer.

**The problem with direct submission**: A Solana transaction requires a fee payer and signer — permanently recorded on-chain. If the user's wallet submits the ring proof transaction directly, the chain permanently records: "wallet_X submitted a ring proof with ring = [c₁...c₁₆]." This links wallet_X to 16 specific ring candidates, reducing the practical anonymity set even if the ring proof correctly hides which element was spent.

**Decision**: Withdrawals are routed through the IKA relay (same path as deposits). The user generates the ring proof client-side and sends it off-chain to the relay. The relay submits on-chain — the relay wallet is the permanent on-chain signer. This makes the chain record read: "relay submitted a ring proof" for every withdrawal, identical in form to every deposit. User wallet never appears in any ShieldedPool transaction.

---

## Unified Exit Path: Relay → PER → Umbra Stealth

**Requirement**: An observer must not be able to classify whether an exit event is a withdrawal or a borrow disbursement.

**The problem without unification**: Withdrawals release SOL from `shielded_pool::withdraw`. Borrow disbursements release SOL from `shielded_pool::disburse` (called via CPI from `lending_pool::borrow`). If these take different on-chain paths or different destination formats, an observer can classify each exit event and infer when borrowing is occurring — even without knowing who the borrower is.

**Decision**: Both withdrawals and borrow disbursements enqueue an `ExitQueueAccount` in the MagicBlock PER. The PER `flush_exits` instruction processes the entire queue and sends each amount to its respective Umbra stealth address in a single batch. From an observer's view: "relay sent SOL to several stealth addresses." The exit type is unclassifiable.

---

## Private Repayment Settlement: MagicBlock Private Payments + ZK Receipt Binding

**Requirement**: Repayment must unlock collateral only after sufficient value has settled, while preserving borrower identity privacy and, in Full Privacy mode, avoiding a public repayment transfer graph.

**Options considered**:
- **Publish repaymentAmount on-chain and check directly**: Simplest and safest for accounting, but reveals repayment amount and creates a visible repayment transfer.
- **ZK circuit with repaymentAmount as private input only**: Proves an amount exists inside a circuit, but does not hide a normal on-chain SOL/SPL transfer. This would overclaim amount privacy unless the settlement rail is also private.
- **FHE verification on encrypted values**: Possible in theory, but adds complexity to a deterministic lending operation and does not by itself move value privately.
- **MagicBlock Private Payments + ZK receipt binding**: Private payments hide the repayment movement. The ZK circuit proves collateral-nullifier authority and binds `loanId`, `nullifierHash`, `outstanding_balance`, and the private payment receipt hash. LendingPool verifies the receipt before unlocking collateral.

**Decision**: MagicBlock Private Payments for repayment settlement, with a new `repay_ring` circuit that binds the locked collateral nullifier to a private payment receipt. This is the correct division of responsibility: MagicBlock hides value movement; ZK proves authorization and binding; the lending program keeps deterministic accounting from public rate history.

**Fallback**: If private payments are unavailable, repayment can still route through the IKA relay for identity privacy. In that degraded path, repayment amount privacy is not claimed.

---

## Randomness: MagicBlock VRF (not Fisher-Yates with block hash)

**Requirement**: Cryptographically unbiasable randomness for dummy commitment insertion and epoch shuffle.

**Options considered**:
- **Block hash / slot hash**: The block producer knows the next slot hash before it is finalized. A colluding validator could bias which dummy commitments are inserted. Grinding attacks possible.
- **Chainlink VRF**: Works on EVM chains. Not available natively on Solana for this use case.
- **MagicBlock VRF**: On-chain verifiable randomness with cryptographic proof per result. Callback-based — the requester cannot manipulate the output after requesting it. Free within ER, 0.0005 SOL on base chain. Proof included in the flush_epoch transaction — verifiable by anyone.

**Decision**: MagicBlock VRF. Block hash entropy is gameable by validators; VRF is not. The per-result cryptographic proof is a stronger security property than "assume validators are honest." VRF runs once at deposit epoch flush time — the resulting dummy commitments persist in the Merkle tree permanently and carry into all future ring proofs.

**Dummy commitment formula**: Dummies must be indistinguishable and unspendable. The implementation must not use `Poseidon(0, 0, denomination)` or any public-only formula. The selected design is:

```
dummy = Poseidon(
  "SHIELDLEND_DUMMY",
  pool_id,
  epoch_id,
  dummy_index,
  magicblock_vrf_output,
  enclave_private_entropy
)
```

The PER/TEE discards the preimage after insertion. Observers can verify that the epoch used MagicBlock VRF randomness, but cannot recompute the dummy set or distinguish dummy leaves from real commitments.

---

## Stealth Addresses: Umbra SDK (replaces custom ERC-5564 implementation)

**Requirement**: Every output address (withdrawal destination, loan disbursement) must be a one-time address with no prior chain history, automatically sweepable by the recipient.

**Options considered**:
- **Custom ECDH stealth address implementation**: The ERC-5564 scheme can be implemented from first principles using a wallet signature as the shared secret. Requires building key derivation, address generation, and sweep logic.
- **Umbra SDK (ScopeLift)**: The team that authored ERC-5564. Solana mainnet alpha as of February 2026 via Arcium. Provides complete stealth address generation, key derivation from meta-address, and auto-sweep functionality.

**Decision**: Umbra SDK. Using the reference implementation from the authors of ERC-5564 eliminates the risk of subtle errors in key derivation that could compromise stealth address privacy. Both withdrawal destinations and borrow disbursement destinations use Umbra — single dependency, unified stealth address scheme.

---

## Post-Flush Notification: `onAccountChange()` (not a dedicated automation service)

**Requirement**: After a PER deposit batch commits to base Solana, the frontend must be notified so the user knows their deposit is confirmed and their note is active.

**Decision**: `@solana/web3.js` native `onAccountChange()` listener on `ShieldedPoolState.merkle_root`. When the Merkle root updates after `flush_epoch`, the listener fires and the frontend derives the updated inclusion path for the user's commitment. No trusted backend or automation service required — the listener runs in the browser and relies only on a standard Solana RPC endpoint.

---

## Encrypt FHE: Oracle MEV Prevention and Aggregate Solvency

**Requirement**: (1) Liquidation oracle price updates must not be front-runnable by MEV bots. (2) Protocol solvency must be verifiable without exposing individual collateral health values.

**Oracle MEV — the problem**: In standard lending protocols, price feeds appear in the mempool before block inclusion. MEV bots read an incoming price, compute the resulting health factors, and submit liquidation or protection transactions before the price update confirms. This creates a profitable MEV extraction window.

**Why FHE is specifically required here**: ZK proofs can prove a fact about a value but cannot stream live oracle inputs homomorphically. Price feeds change continuously — a ZK proof approach would require a new proof per price update, which is not practical for real-time liquidation monitoring. FHE allows the health_factor computation to run directly on an encrypted price input without materializing the plaintext. MEV bots cannot compute health factors from ciphertexts in the mempool.

**Aggregate solvency**: Aggregate collateral coverage can be computed as a homomorphic sum over encrypted collateral-value ciphertexts. Public or bucketed borrow amounts provide deterministic debt accounting. A single threshold decryption reveals only aggregate collateral coverage — individual collateral positions remain hidden throughout.

**Decision**: Encrypt FHE for oracle price encryption, health-factor computation, and aggregate collateral coverage. Targeted compliance disclosure is user-scoped and can combine local history records, proof signals, receipt hashes, and optional threshold evidence without a protocol-wide viewing key.

---

## Liquidation Authorization: IKA FutureSign (not trusted liquidation bot)

**Requirement**: Liquidations must be executable when a health factor is breached, without requiring the borrower's real-time consent, and without trusting a single operator to not abuse the liquidation trigger.

**Options considered**:
- **Trusted operator liquidation bot**: An operator wallet monitors health factors and submits liquidation transactions. Single point of trust — the operator can liquidate at will or refuse to liquidate, manipulating protocol outcomes.
- **Anyone-can-liquidate design**: Any wallet can trigger liquidation of an undercollateralized loan. In a privacy protocol, this reveals that a specific LoanAccount is undercollateralized — and since the operator is anonymous, anyone monitoring can observe and front-run.
- **IKA FutureSign**: At borrow time, the borrower pre-signs a conditional liquidation authorization with their IKA dWallet partial signature. The signed message specifies: liquidate this loanId if health_factor < threshold. The IKA MPC network stores the pre-authorization and completes it when the health factor condition is met — without the borrower needing to be online, and without an operator having discretionary control.

**Decision**: IKA FutureSign. The borrower consents to liquidation terms at borrow time, not operator discretion at liquidation time. The IKA MPC network enforces the condition — neither the borrower nor the operator can override it unilaterally.

---

## Historical Merkle Root Ring Buffer (30 roots)

**Requirement**: Users who go offline for multiple epochs must still be able to withdraw their committed notes. With VRF dummy insertions changing the Merkle root at every epoch flush, a user offline for 2 epochs would find their proof root invalid against the current root.

**Options considered**:
- **Store only current root**: Simplest. Users must withdraw within the same epoch they deposited, or regenerate their proof every epoch. Impractical — forces users to be online continuously.
- **Accept user lockout**: Notes become unspendable after sufficient epochs. Unacceptable — this is permanent loss of funds.
- **Historical root ring buffer (N roots)**: Store the last N Merkle roots. The `withdraw` instruction checks `historical_roots.contains(proof.root)` instead of `proof.root == current_root`. Users can submit proofs against any of the last N roots.

**Decision**: Ring buffer of 30 historical roots. With 5-minute epochs, this gives users approximately 2.5 hours of offline tolerance. 30 × 32 bytes = 960 bytes overhead in `ShieldedPoolState` — negligible for a singleton PDA.

*Architecture inspiration: Railgun and Tornado Cash both retain N historical roots for exactly this reason. Tornado Cash's canonical implementation uses a fixed-size historical roots set checked with `require(isKnownRoot(root))`.*

---

## Nullifier Formula: Position-Dependent + App-Siloed

**Previous formula**: `nullifierHash = Poseidon(nullifier)`

**New formula**: `nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)`

**Why the change — two independent reasons**:

**Reason 1: Position-dependent binding (anti re-insertion attack)**

*Inspiration: Penumbra's nullifier formula `nf = Poseidon(domain_separator, nullifier_key, commitment, position_in_tree)`*

If a commitment is somehow re-inserted at a different leaf position (theoretically possible in a tree with millions of leaves — commitment collision is computationally infeasible but insertion ordering bugs exist), the old formula would produce the same nullifierHash for both positions. An attacker who controls the re-insertion could attempt to claim the note is unspent at the new position even after spending it at the old position.

With `leaf_index` in the hash: the nullifierHash at position 5 is different from the nullifierHash at position 1000 for the same commitment. The double-spend record at position 5 does not conflict with a potential insertion at position 1000.

**Reason 2: App-siloed domain separation (cross-contract unlinkability)**

*Inspiration: Aztec's app-siloed nullifier derivation `nullifier_app = Poseidon(nsk_master, app_contract_address)`*

If ShieldLend ever deploys a V2 program or integrates with a complementary protocol, two different programs would each maintain a nullifier registry. Without a domain separator, a nullifierHash appearing in one program's registry could be correlated with the same hash in another program — linking the user's note across protocols.

Including `SHIELDED_POOL_PROGRAM_ID` as a compile-time constant in the circuit ensures nullifiers are siloed to this specific program. Notes cannot be correlated across protocol versions.

**Circuit change**: `leaf_index` added as private input to all three circuits. Merkle inclusion proof already verifies the commitment is at a specific tree position — `leaf_index` extracts this position and includes it in the nullifierHash computation.

---

## Three-Step Async Liquidation (FHE-Compatible)

**Requirement**: Liquidation requires knowing whether a loan's health factor has breached the threshold. With Encrypt FHE protecting oracle/collateral health computation, the health factor cannot be read directly — it must be threshold-decrypted.

**The problem with single-step liquidation in FHE**: Threshold decryption is asynchronous (requires 2/3 of Encrypt network validators to process). A single-instruction liquidation would either: (a) block synchronously waiting for decryption (impossible in Solana's execution model), or (b) trust the submitter's claim about health factor (no verification — breaks security).

**Pattern adopted from**: Laolex/shieldlend (`ConfidentialLending.sol`) — the most mature FHE lending implementation found in the competitive analysis. Their three-step flow (requestLiquidationReveal → verifyLiquidationReveal → liquidate) handles Zama's async coprocessor decryption. We adapt this to Solana's Anchor/PDA model.

**Step 1** (permissionless): Emit event with FHE handle. Encrypt network initiates decryption.
**Step 2** (called by Encrypt oracle keeper): Verify decryption proof; set `confirmed_liquidatable`.
**Step 3** (permissionless if confirmed): Execute liquidation via IKA FutureSign.

**Handle Pinning [C-01]**: Prevents replay of a decryption result from one loan against another. In EVM: `require(handlesList[0] == FHE.toBytes32(positions[borrower].isLiquidatable))`. In Anchor: the PDA `seeds = [b"loan", collateral_nullifier_hash]` is cryptographically unique per loan and serves as the binding — the Encrypt oracle proof is verified against this PDA address.

**Stale flag clearing [CR-2]**: On any repayment or collateral increase, immediately clear `confirmed_liquidatable`, `pending_liquidation_reveal`, and reset `consecutive_breach_count`. Prevents race condition where position improves post-request but old confirmation executes.

---

## Keeper-Based Interest Accrual (Not In-FHE)

**Requirement**: Interest must accrue without breaking privacy claims or making lending accounting unsafe.

**Why automatic in-FHE accrual is not MVP scope**: To compute an interest rate from utilization (`rate = base + utilization × multiplier`), the protocol needs deterministic total debt and reserve accounting. Hiding borrow amounts inside FHE would make repayment, liquidation, reserves, and bad-debt handling substantially more complex. For MVP, borrow amounts are public or bucketed and interest accrues with public arithmetic; Encrypt FHE protects oracle/health computation and aggregate collateral coverage.

**Pattern adopted from**: Laolex/shieldlend — an admin keeper bot calls `accrueInterest(borrower)` for each active loan on a daily schedule. Utilization is estimated from publicly observable deposit counts (not encrypted balances) and the rate is updated via governance. This is a conscious tradeoff: the rate may lag true utilization by one admin update cycle.

**Our implementation**: A keeper calls `lending_pool::accrue_interest(loan_account)` once per `keeper_min_accrual_slots` (default: ~1 day). The instruction computes `new_balance = balance × (1 + rate)` in public/bucketed lending accounting. The `last_accrual_slot` is a public plaintext field.

**Slot-based timing**: Solana uses slot numbers, not Unix timestamps. `keeper_min_accrual_slots = 216_000` ≈ 1 day at 400ms/slot.

---

## Breach Confirmation Epochs (Anti-Oracle-Manipulation)

**Requirement**: Prevent a single manipulated oracle price update from triggering the liquidation of a healthy position.

**The attack**: Oracle submits a manipulated price (stale data, price spike, compromise) in one slot. Single-epoch FutureSign activation immediately liquidates solvent borrowers.

**Decision**: `consecutive_breach_count` field in `LoanAccount` PDA. Oracle updates increment this counter when health factor is in breach; clear it on oracle updates that show recovery. FutureSign only activates when `consecutive_breach_count >= breach_confirmation_epochs` (default: 2).

**Additional circuit breaker**: If oracle price moves more than `max_oracle_deviation_bps` (default: 20%) between consecutive updates, new liquidation requests are paused for one epoch. This handles sudden large price movements that could be oracle manipulation.

**Borrower protection**: Borrowers have at least one full oracle update epoch to respond to the first breach detection before liquidation becomes possible.

---

## MagicBlock PER Liveness Fallback Modes

**Requirement**: Users must be able to recover their funds even if MagicBlock PER becomes unavailable for an extended period.

**Three operational modes** defined with explicit privacy tradeoffs:

**Full Privacy (default)**: All exits via PER batch. Maximum temporal unlinking. Requires PER operational.

**Degraded Privacy** (auto-activates after 5 epochs without PER flush): Direct ZK withdrawal without PER batching. Ring anonymity (K=16) preserved. Temporal unlinking lost — deposit→exit timing is observable. Frontend displays prominent warning. Instruction `shielded_pool::direct_withdraw(ring_proof, stealth_address)` enabled.

**Emergency** (governance vote, time-locked): Direct SOL release bypassing relay and stealth. Last resort for stuck funds. Ring anonymity may still be preserved if user submits proof directly.

The `per_fallback_epoch_threshold` governance parameter controls automatic Degraded mode activation.

---

## Fixed Pool Denominations (design requirement, not a choice)

**Requirement from ZK circuit structure**: The ZK circuit computes `commitment = Poseidon(secret, nullifier, denomination)`. `denomination_out` is a public output of the withdraw proof — the on-chain contract reads it to know how much SOL to release.

If denominations were variable:
1. Every amount would produce a unique commitment → amounts are fingerprintable
2. The circuit could not enforce denomination integrity without making amount a public output
3. The on-chain program cannot release the correct amount without reading a public denomination value

Fixed denominations (0.1 SOL, 1 SOL, 10 SOL) ensure all deposits in a denomination class are cryptographically indistinguishable. An observer sees "a 1 SOL denomination was withdrawn" — not which deposit it came from.

Borrow amounts are variable and visible on-chain as ZK public inputs — required for on-chain LTV verification. Denomination class (fixed) and borrow amount (variable, public) are independent values in separate circuits.

For MVP, borrow amounts should be offered as supported buckets where possible. Bucketing reduces amount fingerprinting while keeping LTV, reserve accounting, interest accrual, and liquidation deterministic. A public or bucketed borrow amount is metadata leakage, but it does not by itself link a borrower to the original depositor: collateral identity is hidden by the ring proof, the borrower wallet is hidden by the relay, and the disbursement destination is hidden by PER + Umbra.

---

## Conservative Liquidation MVP

**Requirement**: Liquidations must prevent bad debt without creating a complex first-version liquidation surface that can be exploited through precision, stale oracle, or partial-liquidation accounting bugs.

**Options considered**:
- **Partial liquidation in MVP**: Better capital efficiency, but substantially more accounting complexity around remaining collateral, partial debt, privacy state transitions, and repeated liquidation attempts.
- **Full liquidation only**: More conservative and less capital efficient, but easier to reason about, test, and explain. It minimizes bad-debt risk for the hackathon implementation.

**Decision**: MVP uses full liquidation only, minimum borrow size, overcollateralized LTV, liquidation bonus caps, stale-oracle circuit breakers, and reserve accounting. Partial liquidation is a post-MVP extension after invariant tests and accounting audits.

---

## Transaction History and Viewing Keys

**Requirement**: Users need a usable transaction history and optional compliance disclosure, without giving the protocol or third parties a global deanonymization path.

**Decision**: History is client-controlled. The frontend stores an encrypted local journal keyed from the user's wallet signature and optionally backed up by the user. Each record can include operation type, local note id, tx signature, Merkle root, nullifier hash, proof public signals, receipt hash, and display metadata. The protocol does not maintain a user-indexed history table.

For disclosure, the client can generate scoped packets: selected records plus tx signatures, proof public signals, private payment receipt references, and optional auditor viewing key material. A disclosure packet proves that specific events happened without revealing unrelated notes or creating a protocol-wide viewing key.
