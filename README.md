# ShieldLend — Privacy-First Lending Protocol on Solana

A zero-knowledge, privacy-preserving lending protocol on Solana. Deposits are unlinkable to wallets, withdrawal destinations are one-time addresses, oracle data is encrypted against MEV, and the signing infrastructure has no single operator key.

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

Existing privacy tools address one layer at a time: mixers hide amounts but not identities; stealth addresses hide destinations but not deposits; ZK proofs hide which commitment was spent but not who submitted the transaction. ShieldLend addresses all four layers across the full transaction lifecycle.

---

## Design Philosophy

Privacy in DeFi is not a feature — it is a stack.

ShieldLend applies four sequential protections across the transaction lifecycle. Each protection closes a specific gap that no other component addresses:

- **Entry protection** (MagicBlock PER + VRF): Deposits execute inside an Intel TDX enclave. Multiple users' deposits batch before any commitment reaches the Merkle tree — no observer can link a wallet to a specific commitment. VRF generates dummy commitments that are indistinguishable from real ones, permanently expanding the anonymity set for all future ring proofs.

- **Relay protection** (IKA dWallet): Every on-chain operation — deposit, withdrawal, borrow, repay — is submitted by the IKA relay wallet, not the user's wallet. The relay is a 2PC-MPC dWallet: no single key exists. Both the user and the IKA MPC network must participate to authorize any relay operation. All exits (withdrawals and borrow disbursements) route through the same relay → PER batch → stealth path, making their type indistinguishable on-chain.

- **State protection** (Encrypt FHE): Oracle price feeds for health factor computation are submitted as FHE ciphertexts. MEV bots cannot compute liquidation trigger conditions from encrypted mempool data. Aggregate solvency is tracked via homomorphic sum — total outstanding debt is verifiable without revealing individual positions.

- **Exit protection** (Umbra SDK): Every output — withdrawal destinations and loan disbursements — routes to a one-time Umbra stealth address. Each address is derived via ECDH from the recipient's published meta-address, has zero prior chain history, and is abandoned after use.

---

## Protocol Selection

Every protocol in ShieldLend's stack was chosen to close a specific privacy gap that no other tool addressed. The design started from privacy requirements and worked backwards to protocols — not the other way around.

The component-to-protocol mapping tables below show this gap → choice relationship for every function in the protocol. For the full decision rationale (alternatives considered, tradeoffs evaluated), see [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md).

---

## Architecture

ShieldLend is four sequential privacy protections over a single Anchor program core.

```
┌─────────────────────────────────────────────────────────────┐
│  USER INTERFACE (Next.js + snarkjs + Umbra SDK)             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  EXIT PROTECTION — ADDRESS PRIVACY                          │
│  Umbra SDK                                                  │
│  All outputs (withdrawals, loan disbursements) route to     │
│  one-time stealth addresses. User spends directly.          │
│  Address abandoned after single use.                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  STATE PROTECTION — ON-CHAIN DATA                           │
│  Encrypt FHE                                                │
│  Oracle price feeds submitted as FHE ciphertexts.           │
│  Health factor computed homomorphically — MEV-resistant.    │
│  Aggregate solvency via homomorphic sum. Threshold          │
│  decryption for targeted compliance disclosure.             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  RELAY PROTECTION — TRANSACTION ROUTING                     │
│  IKA dWallet                                                │
│  All operations submitted by relay wallet, not user.        │
│  2PC-MPC: no single key. Disbursements require on-chain     │
│  LTV + IKA MPC consensus. FutureSign enables trustless      │
│  pre-authorized liquidation. Unified exit path mixes        │
│  withdrawals and borrow disbursements indistinguishably.    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  ENTRY PROTECTION — EXECUTION PRIVACY                       │
│  MagicBlock PER + VRF                                       │
│  Deposits and exits batch inside Intel TDX enclave.         │
│  VRF-randomized dummy insertions enlarge anonymity set.     │
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
3. The IKA relay batches this deposit with others inside a **MagicBlock Private Ephemeral Rollup** (Intel TDX enclave). The batch processes privately.
4. PER commits a batch to ShieldedPool (TX2 — signer is the IKA relay wallet, not the user). TX1 and TX2 are not one-to-one.
5. VRF-randomized dummy commitments are inserted alongside real ones, permanently enlarging the anonymity set for all future ring proofs.

Observer sees TX1: "User funded relay." Observer sees TX2: "Relay deposited batch to pool." No linking between them.

### Withdrawal

No observer can connect the depositor's wallet to the withdrawal destination.

1. User loads their note (secret + nullifier) from the local encrypted vault.
2. `snarkjs` generates a **Groth16 ring proof**: proves ownership of one commitment in a ring of 16, without revealing which one. VRF dummies inserted at deposit time appear in the ring — the effective anonymity set exceeds K=16.
3. User sends proof to the **IKA relay** (off-chain). Relay submits the withdrawal transaction on-chain — relay wallet is the signer, not the user's wallet.
4. `groth16-solana` verifies the proof on-chain (< 200k compute units). SOL released from ShieldedPool to relay.
5. The exit is queued in **MagicBlock PER** alongside other withdrawals and borrow disbursements. PER flushes the batch to respective **Umbra stealth addresses**.
6. User derives the private key for their stealth address via Umbra SDK and spends directly — no forwarding to a main wallet needed.

The ring proof hides *which* commitment was spent. Relay routing hides *who* submitted the proof. The stealth address hides *where* the funds went.

### Borrow

The collateral identity, borrower wallet, and disbursement destination are not linkable.

1. User selects a committed note as collateral.
2. `snarkjs` generates a **Groth16 collateral proof**: proves ring membership + denomination ≥ borrowed × LTV floor — in-circuit. Ring includes VRF dummies from deposit time.
3. User sends proof to the **IKA relay**. Relay submits on-chain — relay wallet is the signer.
4. `groth16-solana` verifies the proof on-chain.
5. The **IKA dWallet** receives an `approve_message()` CPI. The program validates LTV; the IKA MPC network co-signs the disbursement. Both gates required — no single operator can disburse.
6. SOL exits ShieldedPool → relay → **MagicBlock PER exit batch** (mixed with withdrawals) → **Umbra stealth address**. The exit is indistinguishable from a withdrawal on-chain.

No observer links "this commitment is locked as collateral" to "this wallet received a loan."

### Repay

Repayment does not reveal the borrower's identity or the repayment amount.

1. User generates a **repay_ring proof**: proves knowledge of the collateral nullifier. The repayment amount satisfies `repaymentAmount ≥ outstanding_balance` — verified in-circuit with repaymentAmount as a private input. The borrower's wallet is never revealed.
2. SOL goes via the **IKA relay** — indistinguishable from deposit relay traffic.
3. `groth16-solana` verifies the repay proof on-chain.
4. Loan PDA cleared, nullifier unlocked. Collateral note is ready for withdrawal.

---

## Detailed Privacy Flow Diagrams

The diagrams below trace each operation step-by-step, showing exactly which data is visible to an on-chain observer at each stage, why each component is present, and what privacy property it closes.

### Flow 1: Deposit

```
USER BROWSER
│
│  Generates: (secret, nullifier, denomination) — stays in browser WASM
│  Computes:  commitment = Poseidon(secret, nullifier, denomination)
│  Stores:    AES-256-GCM encrypted note → local vault
│
│  TX1: user wallet → IKA relay (SOL transfer, on-chain)
│       Observer sees: "wallet sent SOL to relay address"
│       Observer does not see: which commitment, that this is ShieldLend
│
▼
IKA RELAY inside MagicBlock PER (Intel TDX Enclave)
│
│  Multiple users' (SOL + commitment) pairs accumulate in enclave
│  Epoch trigger fires
│
│  VRF generates: n_dummies + dummy positions
│    Dummy commitments = valid Poseidon(vrf_seed_1, vrf_seed_2, denomination)
│    No backing SOL. Unredeemable. Structurally identical to real commitments.
│    Remain in Merkle tree permanently as ring proof candidates.
│
│    WHY VRF NOT BLOCK HASH: validators can manipulate block hash to make
│    dummy positions predictable; VRF proof included on-chain is verifiably unbiasable
│
│  PER submits TX2 (single batch):
│    Signer = IKA relay wallet (not any user)
│    Inserts: [commitment_A, commitment_B, commitment_C, dummy_1, dummy_2, ...]
│    All simultaneously — T₁, T₂, T₃ → single T_batch
│
▼
SHIELDED POOL — MERKLE TREE
│
│  All commitments inserted, new root posted
│  Real and dummy commitments: visually identical on-chain
│
│  onAccountChange() listener in frontend detects root update →
│  signals deposit confirmed to user

PRIVACY AT DEPOSIT:
  Who deposited:         hidden — relay is TX2 signer
  Which commitment:      hidden — N users + dummies batch, no T₁→commit mapping
  Anonymity set:         expanded — VRF dummies permanently in ring candidate pool
  Denomination class:    visible (required by ZK circuit design — accepted)
```

---

### Flow 2: Withdrawal

```
USER BROWSER
│
│  Loads note: (secret, nullifier, denomination) from AES-256-GCM vault
│  Fetches Merkle root, builds ring of K=16 commitments from pool
│    Ring includes: own commitment + 15 others, including VRF dummies
│    (VRF dummies inserted at deposit time are already in the tree)
│
│  Generates Groth16 ring proof (snarkjs WASM, ~1.2s):
│    PRIVATE: secret, nullifier, denomination, Merkle path[24], ring_index
│    PUBLIC:  ring[16], nullifierHash, root, denomination_out
│
│  Sends proof + Umbra stealth meta-address to IKA relay (off-chain)
│
│    WHY WITHDRAWAL GOES THROUGH RELAY:
│      Direct on-chain submission makes the user's wallet the transaction signer.
│      The chain permanently records: "wallet_X submitted a ring proof
│      with ring = [c₁...c₁₆]" — linking wallet_X to 16 ring candidates.
│      Relay routing makes the relay wallet the signer for both deposits
│      and withdrawals — both flows are indistinguishable on-chain.
│
▼
IKA RELAY submits on-chain (relay wallet = signer)
│
│  shielded_pool::withdraw instruction
│
▼
ON-CHAIN
│
│  groth16_solana::verify — ring proof verified atomically with fund release
│  nullifier_registry::mark_spent(nullifierHash) — double-spend prevention
│  ShieldedPool releases SOL → IKA relay account
│
▼
IKA RELAY / PER — EXIT BATCH
│
│  This withdrawal exit queued alongside borrow disbursement exits
│  All exits: same source (relay), same destination format (Umbra stealth)
│  PER batch flushes → each exit sent to its respective stealth address
│
│    WHY EXITS ALSO BATCH THROUGH PER:
│      Withdrawal and borrow disbursement exits are structurally identical
│      in the batch. Observer sees: "relay sent SOL to stealth addresses"
│      Cannot classify: withdrawal vs. borrow disbursement
│
▼
UMBRA STEALTH ADDRESS
│
│  Fresh one-time ECDH-derived address — zero prior chain history
│  Only recipient can derive private key (from stealth meta-address)
│  User spends directly from stealth address
│
│  onAccountChange() detects state update → frontend derives stealth key + shows balance

PRIVACY AT WITHDRAWAL:
  Who submitted ring proof:   hidden — relay is on-chain signer
  Which commitment was spent: hidden — ring proof 1-of-16
  Withdrawal destination:     hidden — Umbra stealth (fresh, no history)
  Exit type classification:   hidden — same batch path as borrow disbursements
  NullifierHash:              visible (necessary for double-spend prevention, one-way)
  Denomination class:         visible (necessary — contract must know release amount)
```

---

### Flow 3: Borrow

```
USER BROWSER
│
│  Loads collateral note: (secret, nullifier, denomination)
│  Chooses borrow amount — this is a ZK public input, visible on-chain
│    (required: verifier must bind the LTV claim to the actual disbursement amount)
│
│  Generates Groth16 collateral ring proof (snarkjs WASM):
│    PRIVATE: secret, nullifier, denomination, Merkle path[24], ring_index
│    PUBLIC:  ring[16], nullifierHash, root, borrowed, minRatioBps
│    CIRCUIT: denomination × 10000 ≥ borrowed × minRatioBps (LTV check in-circuit)
│
│  VRF dummies already in Merkle tree from deposit time →
│  ring[16] naturally includes dummy commitments as candidates
│
│  Sends proof + borrow amount + Umbra stealth address to IKA relay (off-chain)
│
▼
IKA RELAY submits on-chain (relay wallet = signer)
│
│  lending_pool::borrow instruction
│
▼
ON-CHAIN
│
│  groth16_solana::verify — collateral proof verified
│  nullifier_registry: Active → Locked (note held as collateral, not spent)
│  LoanAccount PDA created: stores nullifierHash + loan terms
│
│  IKA dWallet co-signs disbursement:
│    On-chain LTV verification (ZK proof) AND IKA MPC network approval
│    Both required — neither party can disburse alone
│
│  IKA FutureSign stored:
│    Borrower pre-authorizes: "liquidate loan X if health_factor < Y"
│    Stored at borrow time. Borrower cannot block a valid liquidation later.
│    Operator cannot execute without the health factor condition being met.
│
│  ShieldedPool releases SOL → IKA relay account
│
▼
IKA RELAY / PER — EXIT BATCH (same path as withdrawal)
│
│  Disbursement queued alongside withdrawal exits
│  Observer: "relay sent SOL to stealth address" — same as withdrawal
│  PER batch flush → SOL to Umbra stealth address
│
▼
UMBRA STEALTH ADDRESS (borrow recipient)
│
│  Fresh one-time address — borrower's wallet never appears on-chain
│  User spends directly from stealth address

PRIVACY AT BORROW:
  Borrower wallet:          hidden — ZK private input + relay signer
  Which collateral note:    hidden — ring proof 1-of-16 (VRF dummies in ring)
  Disbursement destination: hidden — Umbra stealth address
  Borrow vs withdrawal:     hidden — same relay exit path + PER batch
  Borrow amount:            visible (ZK public input — accepted)
  That a borrow occurred:   visible (LoanAccount PDA created in tx — accepted)
```

---

### Flow 4: Repay

```
USER BROWSER
│
│  Loads collateral note: (secret, nullifier)
│  Retrieves loanId (stored locally at borrow time)
│
│  Queries on-chain: current outstanding balance
│    Outstanding balance = borrowed × compound(rate_history, elapsed_blocks)
│    Kamino rate history is on-chain — program computes it at repay time
│
│  Generates Groth16 repay_ring proof (snarkjs WASM):
│    PRIVATE: nullifier, repaymentAmount
│    PUBLIC:  nullifierHash, loanId, outstanding_balance
│    CIRCUIT: repaymentAmount ≥ outstanding_balance
│             (sufficiency check in-circuit; repaymentAmount never on-chain)
│
│  Routes repayment SOL through IKA relay (same relay as deposits)
│    Repayment traffic: indistinguishable from deposit traffic on-chain
│
▼
IKA RELAY submits on-chain (relay wallet = signer)
│
│  lending_pool::repay instruction
│
▼
ON-CHAIN
│
│  groth16_solana::verify — repay proof verified
│    Confirms: repayer knows the nullifier (authorization)
│    Confirms: repayment amount is sufficient (in-circuit, private)
│
│  nullifier_registry: Locked → Active
│    Collateral note is free — can be withdrawn via standard withdrawal flow
│
│  LoanAccount PDA closed

PRIVACY AT REPAY:
  Repayer wallet:         hidden — relay signer + ZK private input
  Repayment amount:       hidden — ZK private input, circuit verifies privately
  Outstanding balance:    computed on-chain from public rate history (Kamino)
                          — known to the contract, needed for verification
  Repayer = borrower:     not provable on-chain — nullifier proves authorization,
                          not wallet identity
  Repay vs deposit:       indistinguishable via relay routing
```

---

### Liquidation

```
ENCRYPT FHE oracle inputs:
│
│  Price feed submitted as FHE ciphertext
│  Health factor = FHE(collateral_value) / FHE(borrowed) — computed homomorphically
│  MEV bots cannot compute breach condition from mempool ciphertext
│
│    WHY FHE HERE SPECIFICALLY:
│      ZK proofs can prove a fact about a value, but cannot stream live
│      oracle updates homomorphically. FHE is uniquely capable of allowing
│      the health factor computation to run on a hidden, streaming value.
│
│  Threshold decryption (2/3 Encrypt MPC): reveals health_factor boolean only
│
IKA FutureSign executes:
│  Pre-authorization from borrow time activates
│  Collateral: Locked → Spent
│  LoanAccount PDA closed

PRIVACY: who was liquidated is not linkable to a wallet — loanId visible, wallet never was
```

---

## Privacy Status

Complete property-by-property breakdown of what is and is not hidden:

```
PROPERTY                             STATUS      MECHANISM
────────────────────────────────────────────────────────────────
Depositor wallet hidden              ✓           IKA relay (relay is TX2 signer)
Deposit timing correlation broken    ✓           PER temporal batching
Anonymity set ≥ 16                   ✓           ZK ring proof K=16
VRF dummies in all ring proofs       ✓           Inserted at deposit; persist in tree
Withdrawal submitter wallet hidden   ✓           Withdrawal routed through relay
Which commitment was spent           ✓           Ring proof hides ring_index
Withdrawal destination hidden        ✓           Umbra stealth (ECDH, fresh per op)
Borrow vs withdrawal exit            ✓           Unified relay → PER → stealth path
Which collateral note is locked      ✓           Collateral ring proof hides index
Borrower wallet hidden               ✓           ZK private input + relay signer
Disbursement destination hidden      ✓           Umbra stealth address
Borrow amount                        public      ZK public input — circuit requirement
That a borrow occurred               public      LoanAccount PDA — accepted
Repayment amount hidden              ✓           ZK private input, circuit check
Repayer wallet hidden                ✓           ZK private input + relay routing
Oracle price (liquidation MEV)       ✓           Encrypt FHE encrypted oracle
Who was liquidated                   ✓           Wallet never linked to loanId
────────────────────────────────────────────────────────────────
```

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
- **Deposit**: IKA relay → ShieldedPool (via PER batch)
- **Withdraw**: ShieldedPool → IKA relay → PER exit batch → Umbra stealth address
- **Borrow**: ShieldedPool → IKA relay → PER exit batch → Umbra stealth address (same path as withdraw)
- **Repay**: IKA relay → ShieldedPool; LendingPool clears loan PDA

---

## ZK Circuits

All circuits produce Groth16 proofs verified on-chain by `groth16-solana`.

| Circuit | Proves | Public inputs/outputs |
|---|---|---|
| `withdraw_ring.circom` | Ring membership (K=16) + Merkle inclusion (depth 24) | `ring[16]`, `nullifierHash`, `root`, `denomination_out` |
| `collateral_ring.circom` | Ring membership + `denomination × minRatioBps ≥ borrowed × 10000` | `ring[16]`, `nullifierHash`, `root`, `borrowed`, `minRatioBps` |
| `repay_ring.circom` | Nullifier knowledge + `repaymentAmount ≥ outstanding_balance` (in-circuit, amount private) | `nullifierHash`, `loanId`, `outstanding_balance` |

---

## Fixed Denominations

Deposits use fixed denominations (0.1 SOL, 1 SOL, 10 SOL). This is a requirement of the ZK circuit design: denomination is embedded in the commitment hash and is a public output of the withdrawal proof. Standardized denominations prevent amount-based correlation — every participant in a denomination pool looks identical on-chain.

Loan amounts are variable. The borrow amount appears as a public input to the collateral ring circuit — required for on-chain LTV verification binding.

---

## Protocol Solvency — Aggregate Without Individual Exposure

ShieldLend maintains continuous solvency guarantees without revealing oracle price data or individual collateral positions.

**Aggregate monitoring (always-on):** Oracle price feeds are submitted as Encrypt FHE ciphertexts. Collateral values are computed homomorphically — price × denomination for each active loan — and summed without decrypting any individual position:
```
total_collateral_value = Σ(FHE_price × denomination[i])   // FHE multiplication + addition
total_outstanding      = Σ(borrow_amount[i])               // plaintext sum — borrow amounts are public
```
Threshold decryption reveals ONLY `total_collateral_value`. Individual collateral positions and the oracle price used for computation stay hidden. MEV bots monitoring the mempool cannot compute breach conditions from encrypted price inputs.

**Targeted audit (on-demand):** For compliance disclosure of a specific loan, threshold decryption reveals that loan's outstanding balance to the auditor. Borrower identity is not revealed — only the amount.

---

## Component → Protocol Mapping

### ShieldedPool

| Function | Protocol | Why this protocol |
|---|---|---|
| Deposit batching + execution | MagicBlock PER (TDX enclave) | Intel TDX required to batch deposits without any party observing the deposit→commitment mapping |
| Exit batching (withdrawals + disbursements) | MagicBlock PER (same enclave) | Both withdrawal and borrow disbursement exits batch together — type indistinguishable on-chain |
| Anonymity set expansion | MagicBlock VRF | Dummy insertions must be cryptographically unbiasable; VRF provides per-shuffle on-chain verifiable randomness; carries forward into all future ring proofs |
| Withdrawal submission | IKA relay | User wallet would be the ring proof transaction signer if submitted directly — permanently linking wallet to 16 ring candidates; relay routing prevents this |
| Withdrawal authorization | groth16-solana | Ring proof verified on-chain atomically with fund release; BN254 native syscalls (<200k CU) |
| Withdrawal recipient | Umbra SDK | One-time stealth address with zero prior history; Umbra SDK handles generation, key derivation |

### LendingPool

| Function | Protocol | Why this protocol |
|---|---|---|
| Interest rate model | Kamino klend fork | Poly-linear 11-point model from a $3.2B TVL production protocol; audited; Anchor-native |
| Collateral proof verification | groth16-solana | LTV check is a circuit constraint — must verify on-chain before disbursement |
| Repayment proof verification | groth16-solana | Repay proof hides repayment amount (private input) and borrower wallet; on-chain verification required to clear loan PDA |
| Disbursement routing | IKA relay + PER | Disbursement exits same relay → PER → stealth path as withdrawals; indistinguishable on-chain |
| Disbursement signing | IKA dWallet | Co-signing requires program LTV validation AND IKA MPC network; no single operator key |
| Disbursement recipient | Umbra SDK | Same reason as withdrawals — fresh stealth address, borrower wallet never on-chain |
| Oracle MEV prevention | Encrypt FHE | Price feeds as FHE ciphertexts; health_factor computed homomorphically; MEV bots cannot read pending price updates |
| Aggregate solvency | Encrypt FHE | Homomorphic sum of loan balances; only total revealed, individual positions stay encrypted |
| Compliance disclosure | Encrypt threshold decryption | Individual loan balance disclosed to auditor via 2/3 MPC threshold decrypt; no global exposure |
| Liquidation pre-authorization | IKA FutureSign | Borrower consents at borrow time; neither borrower (cannot block) nor operator (cannot trigger without condition) has unilateral control |

---

## Privacy Guarantee Summary

| Threat | Mitigation | Protocol |
|---|---|---|
| Depositor wallet visible in pool tx | IKA relay + PER batching | IKA + MagicBlock PER |
| Timing correlation (deposit→pool) | PER batches multiple users; TX1 and TX2 are not one-to-one | MagicBlock PER |
| Anonymity set too small | VRF dummy insertions — persistent in Merkle tree, appear in all future ring proofs | MagicBlock VRF |
| Withdrawal submitter wallet on-chain | Withdrawal routed through IKA relay; relay wallet is signer | IKA relay |
| Withdrawal linked to deposit | Ring proof (K=16 + VRF dummies): cannot identify which commitment was spent | Circom + VRF |
| Withdrawal destination known | Umbra stealth address: one-time, no prior history | Umbra SDK |
| Borrow vs withdrawal distinguishable | Unified relay → PER → stealth exit path for both | IKA relay + PER |
| Borrower wallet linked to loan | Ring proof hides index; relay wallet is signer; Umbra stealth disbursement | Circom + IKA + Umbra |
| Repayer identity revealed | repay_ring ZK proof hides wallet; relayed via IKA | Circom + IKA |
| Oracle front-running (liquidation MEV) | Encrypted oracle; health_factor computed on ciphertext | Encrypt FHE |
| Single operator key risk | IKA 2PC-MPC (user + MPC network both required) | IKA |
| Liquidation trust | IKA FutureSign (pre-signed consent; condition-gated) | IKA |
| Double-spend | NullifierRegistry PDA + ZK nullifierHash | ZK + Anchor |

---

## Tech Stack

**On-Chain**
- Anchor (Rust smart contracts)
- Kamino klend fork (lending logic)
- groth16-solana (ZK proof verification, BN254 native syscalls, Light Protocol Labs)
- MagicBlock PER macros (`#[ephemeral]`, `#[delegate]`, `#[commit]`)
- MagicBlock VRF SDK
- IKA dWallet Anchor CPI (`ika-dwallet-anchor`)
- Encrypt FHE Anchor integration (`encrypt-anchor`)
- Poseidon hash (matching circuits)

**Off-Chain / Client**
- snarkjs 0.7.4 (Groth16 browser proof generation, ~1.2s)
- Circom (withdraw_ring, collateral_ring, repay_ring)
- Umbra SDK (TypeScript, stealthaddress.dev)
- AES-256-GCM + HKDF (client-side note vault, from wallet signature)
- Next.js 14 + React 18
- @solana/wallet-adapter + @solana/web3.js (`onAccountChange` for post-flush automation)

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
│   ├── repay_ring.circom       # nullifier knowledge + repaymentAmount >= outstanding_balance
│   └── keys/                   # .zkey + .vkey.json for all three circuits
├── tests/
│   ├── shielded_pool.ts
│   ├── lending_pool.ts
│   └── live-test.mjs           # E2E devnet
├── frontend/
│   ├── app/
│   │   └── api/
│   │       ├── ika/route.ts    # IKA dWallet approve_message endpoint
│   │       └── per/route.ts    # MagicBlock PER deposit + exit endpoint
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
│   ├── architecture.md         # Deep technical architecture and program design
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
| IKA + Encrypt Frontier | Superteam | dWallet relay (all flows) + FutureSign + encrypted oracle + aggregate solvency |
| Colosseum Privacy Track | MagicBlock | PER deposit batching + PER exit batching + VRF dummy insertion |
| Umbra Side Track | Frontier | Umbra SDK for all output addresses (withdrawals + loan disbursements) |

Each track covers a distinct privacy layer — entry execution, transaction routing, on-chain state, and exit address — with no overlap between them.

---

## Pre-Alpha Status

Several protocols used in ShieldLend are in pre-alpha on devnet. Hackathon integration uses mock signers / unencrypted fallbacks. Production deployments require mainnet availability.

| Protocol | Devnet status | Production path |
|---|---|---|
| IKA dWallet | Pre-alpha (mock signer) | IKA Solana mainnet |
| Encrypt FHE | Pre-alpha (plaintext fallback) | Encrypt mainnet |
| MagicBlock PER | Devnet (Discord access required) | MagicBlock PER mainnet |
| groth16-solana | Mainnet-beta ready | BN254 syscalls live since Solana 1.18.x |
| Umbra SDK | Mainnet alpha (Solana, Feb 2026) | Production-ready |

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Program design, CPI flows, account model, data structures |
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
