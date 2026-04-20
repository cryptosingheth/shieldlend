# ShieldLend — Design Decisions

Every protocol and component choice in ShieldLend answers a specific privacy or security requirement. This document records what was required, what was considered, and why the chosen approach was selected.

---

## Smart Contract Framework: Anchor (not Bolt)

**Requirement**: A Solana smart contract framework that supports MagicBlock's PER/VRF/Session Keys/ER macros.

**Options considered**:
- **Bolt (MagicBlock's ECS framework)**: Extends Anchor with Entity-Component-System patterns. Optimized for gaming (entity positions, velocity, health bars). Introduces ECS abstractions (World, Entity, Component) that add overhead with no benefit for financial state machines.
- **Anchor (plain)**: MagicBlock's `#[ephemeral]`, `#[delegate]`, `#[commit]`, VRF SDK, and Session Keys program all work directly with plain Anchor macros. No ECS layer needed.

**Decision**: Plain Anchor. Bolt's ECS pattern adds complexity for a financial protocol whose state is account mappings and PDAs, not game entities.

---

## Lending Logic: Kamino klend Fork (not Aave v3 port)

**Requirement**: A production-quality, audited lending interest rate model that runs on Solana.

**Options considered**:
- **Aave v3 two-slope model**: Well-known, widely used. Two kink points — base rate below optimal, jump rate above optimal. Solidity implementation not portable directly; requires full rewrite.
- **Custom flat rate**: Simple but inaccurate — cannot price risk differentiation at varying utilization levels.
- **Kamino klend (Anchor, open source)**: Poly-linear 11-point model directly from a $3.2B TVL production Solana protocol. Already Anchor-compatible. Audited. More granular than two-slope — rate can be tuned at 11 utilization levels to match market conditions precisely.

**Decision**: Kamino klend fork. It is purpose-built for Solana, audited, and operationally proven at scale. The 11-point poly-linear model gives finer rate control than a two-slope port.

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

**Requirement**: The user's wallet must not appear in the ShieldedPool deposit transaction.

**Options considered**:
- **Server-side relay (Next.js API route with private key)**: Relayer holds a private key. Single point of failure — compromise of the server compromises all relay operations. The relayer can censor, front-run, or selectively include deposits.
- **IKA dWallet relay**: No private key exists. The relay wallet is a 2PC-MPC dWallet — every operation requires both user partial signature AND IKA MPC network co-signature. No single party can forge a relay transaction.
- **MagicBlock PER batching on top of IKA relay**: Deposits are queued in an Intel TDX enclave before committing to Solana. Multiple users' deposits are batched into a single TX2. The enclave cannot be read from outside — even the PER operator cannot link individual users to their commitments within the batch.

**Decision**: IKA dWallet for relay signing (eliminates operator key risk) + MagicBlock PER for batching (eliminates timing correlation and deposit→commitment linkage). These are complementary — IKA handles signing trust; PER handles batch privacy.

---

## Randomness: MagicBlock VRF (not Fisher-Yates with block hash)

**Requirement**: Cryptographically unbiasable randomness for dummy commitment insertion and epoch shuffle.

**Options considered**:
- **Block hash / slot hash**: The block producer knows the next slot hash before it is finalized. A colluding validator could bias which dummy commitments are inserted. Grinding attacks possible.
- **Chainlink VRF**: Works on EVM chains. Not available natively on Solana for this use case.
- **MagicBlock VRF**: On-chain verifiable randomness with cryptographic proof per result. Callback-based — the requester cannot manipulate the output after requesting it. Free within ER, 0.0005 SOL on base chain. Proof included in the flush_epoch transaction — verifiable by anyone.

**Decision**: MagicBlock VRF. Block hash entropy is gameable by validators; VRF is not. The per-result cryptographic proof is a stronger security property than "assume validators are honest."

---

## Stealth Addresses: Umbra SDK (replaces custom ERC-5564 implementation)

**Requirement**: Every output address (withdrawal destination, loan disbursement) must be a one-time address with no prior chain history, automatically forwarding to the recipient.

**Options considered**:
- **Custom ECDH stealth address implementation**: The ERC-5564 scheme can be implemented from first principles using a wallet signature as the shared secret. Requires building key derivation, address generation, and sweep logic.
- **Umbra SDK (ScopeLift)**: The team that authored ERC-5564. Solana mainnet alpha as of February 2026 via Arcium. Provides complete stealth address generation, key derivation from meta-address, and auto-sweep functionality. Explicit payroll integration use case documented.

**Decision**: Umbra SDK. Using the reference implementation from the authors of ERC-5564 eliminates the risk of subtle errors in key derivation that could compromise stealth address privacy. The SDK handles all stealth operations: withdrawal destinations, borrow disbursement destinations, and payroll→deposit flows. Single dependency, unified stealth address scheme.

---

## Loan Amount Privacy: Encrypt FHE (not zero-knowledge range proofs)

**Requirement**: Loan amounts and interest balances must not be readable on-chain.

**Options considered**:
- **ZK range proofs on loan amounts**: Proves a value is in a range without revealing it. Does not hide the fact that an amount exists, and the range itself leaks information about the value.
- **Commitments (Pedersen)**: Hides the amount behind a commitment. Requires revealing for liquidation — defeats the purpose.
- **Encrypt FHE ciphertext accounts**: Loan balances stored as FHE ciphertexts. Homomorphic operations (addition for interest accrual, comparison for LTV and liquidation triggers) run on the ciphertexts. Values are never materialized in plaintext on-chain.

**Decision**: Encrypt FHE. It is the only approach that allows computing on hidden values (interest accrual, aggregate solvency check) without revealing them. The threshold decryption mechanism (2/3 IKA MPC) provides the disclosure path for auditors without requiring a backdoor key.

---

## Liquidation Authorization: IKA FutureSign (not trusted liquidation bot)

**Requirement**: Liquidations must be executable when a health factor is breached, without requiring the borrower's real-time consent, and without trusting a single operator to not abuse the liquidation trigger.

**Options considered**:
- **Trusted operator liquidation bot**: An operator wallet monitors health factors and submits liquidation transactions. Single point of trust — the operator can liquidate at will or refuse to liquidate, manipulating protocol outcomes.
- **Anyone-can-liquidate design**: Any wallet can trigger liquidation of an undercollateralized loan. In a privacy protocol, this reveals that a specific LoanAccount is undercollateralized — and since the operator is anonymous, anyone monitoring can observe and front-run.
- **IKA FutureSign**: At borrow time, the borrower pre-signs a conditional liquidation authorization with their IKA dWallet partial signature. The signed message specifies: liquidate this loanId if health_factor < threshold. The IKA MPC network stores the pre-authorization and completes it when the ER bot signals the condition is met — without the borrower needing to be online, and without an operator having discretionary control.

**Decision**: IKA FutureSign. The borrower consents to liquidation terms at borrow time, not operator discretion at liquidation time. The IKA MPC network enforces the condition — neither the borrower nor the operator can override it unilaterally.

---

## Health Factor Monitoring: MagicBlock ER (not base-layer Solana)

**Requirement**: Continuous health factor monitoring for liquidation triggers. Must be fast enough to prevent MEV attacks on liquidation timing.

**Options considered**:
- **Base-layer Solana polling (400ms block time)**: Liquidation condition could remain unmet for up to 400ms. MEV bots monitoring the base chain can observe pending liquidation transactions and front-run.
- **Keeper bot + Jito bundles**: Liquidation via Jito MEV bundles. Requires a trusted keeper wallet and creates MEV competition.
- **MagicBlock ER (1ms block time)**: Health factor checks run at sub-millisecond cadence inside the ephemeral rollup. The ER block time is faster than any base-layer MEV opportunity. Liquidation triggers commit to base Solana atomically after health_factor breach is confirmed — no front-running window.

**Decision**: MagicBlock ER. The 1ms block time eliminates the MEV front-running window that makes liquidation bots profitable. The ER runs as a standard (non-private) rollup since liquidation health monitoring is a public operation — privacy overhead not needed here.

---

## Session UX: MagicBlock Session Keys (not per-transaction wallet signing)

**Requirement**: Users should not need to approve every secondary operation (stealth address sweep, note vault access, dummy monitoring) with a wallet prompt.

**Options considered**:
- **Per-transaction signing**: Every operation requires a Phantom/Backpack confirmation dialog. Acceptable for primary actions (deposit, withdraw, borrow). Disruptive for automated secondary operations.
- **Server-side session wallet**: A server holds a temporary keypair scoped to the user's session. Server custody of the session keypair — same trust problem as server-side relay.
- **MagicBlock Session Keys**: An ephemeral keypair is authorized by the user's wallet once per session and stored in a Session Token PDA. The keypair expires after a configurable timeout. All secondary operations (auto-sweep, monitoring) sign with the session keypair without wallet prompts.

**Decision**: MagicBlock Session Keys. The session keypair's scope is limited by the Session Token PDA — it cannot perform operations outside what the user's wallet authorized. This is the least-privilege solution with the best UX.

---

## Post-PER Automation: MagicBlock Magic Actions

**Requirement**: When the PER commits a deposit batch to base Solana, the Umbra stealth address sweep for completed deposits must trigger automatically.

**Options considered**:
- **User-initiated sweep**: User polls for PER commit confirmation and manually initiates sweep. Adds a manual step and a latency window where funds sit in the stealth address.
- **Backend webhook**: Server monitors PER commit events and submits sweep transactions. Requires a trusted backend.
- **MagicBlock Magic Actions**: A triggered base-layer transaction that fires automatically when a specified PER state transition occurs. Deterministic — no trusted intermediary.

**Decision**: Magic Actions. Removes the requirement for a trusted backend to monitor PER commits. The trigger is defined in the PER program itself — no off-chain component needed.

---

## Fixed Pool Denominations (design requirement, not a choice)

**Requirement from ZK circuit structure**: The ZK circuit computes `commitment = Poseidon(secret, nullifier, denomination)`. `denomination_out` is a public output of the withdraw proof — the on-chain contract reads it to know how much SOL to release.

If denominations were variable:
1. Every amount would produce a unique commitment → amounts are fingerprintable
2. The circuit could not enforce denomination integrity without making amount a public output
3. Making amount a public output reveals loan size, defeating Encrypt FHE

Fixed denominations (0.1 SOL, 1 SOL, 10 SOL) ensure all deposits in a denomination class are cryptographically indistinguishable. An observer sees "a 1 SOL denomination was withdrawn" — not which deposit it came from.

Loan amounts are separate and variable. They are hidden by Encrypt FHE — the denomination class (fixed) and the borrowed amount (variable, hidden) are independent values.
