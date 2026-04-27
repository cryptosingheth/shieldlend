# ShieldLend — Privacy Model and Threat Analysis

---

## What ShieldLend Protects

ShieldLend is a lending protocol where the following facts must be unobservable to any external party — including chain validators, relay operators, and other protocol users:

| Protected fact | Why it matters |
|---|---|
| Which wallet deposited | Prevents building profiles of depositors |
| Which commitment corresponds to which depositor | Prevents tracing withdrawal back to deposit |
| Who is the borrower behind a loan | Prevents identity-linked credit profiling |
| Who repaid a loan | Prevents confirmation of identity |
| Repayment transfer graph and amount in Full Privacy mode | Prevents linking a payment source to a loan closure |
| Where funds went after withdrawal or disbursement | Prevents tracking funds post-exit |
| Whether an exit was a withdrawal or a borrow disbursement | Prevents inferring loan activity from exit patterns |

Borrow amount and denomination class are visible or bucketed on-chain as ZK public inputs — required for the on-chain program to verify LTV, interest accrual, reserves, and liquidation constraints. These are accepted disclosures. They create amount-fingerprinting risk, but do not by themselves link a borrower to the original depositor.

---

## Four Sequential Privacy Protections

ShieldLend applies layered protections across the full transaction lifecycle:

| Layer | Protection | Mechanism |
|---|---|---|
| Entry | Depositor wallet hidden from commitment | IKA relay + MagicBlock PER batch |
| Relay | Timing correlation eliminated | PER temporal batching (Intel TDX enclave) |
| Anonymity | Ring membership unlinkability | ZK ring proof K=16 + VRF dummies |
| Payment | Repayment amount/transfer graph privacy | MagicBlock Private Payments + receipt binding |
| Exit | Destination and exit type hidden | Relay → PER exit batch → Umbra stealth address |

---

## Threat Model

### Adversary Classes

**Class A — Passive on-chain observer**
Reads all transactions, account states, event logs. Cannot decrypt encrypted accounts. Cannot access enclave-internal state. Most realistic adversary.

**Class B — Active chain participant**
Controls one or more wallets. Can submit transactions, watch mempool. Cannot break cryptographic commitments or forge ZK proofs.

**Class C — Malicious relay operator**
Controls the IKA relay wallet used for deposit, withdrawal, and repay routing. Can observe the user→relay transaction (TX1). Cannot forge ZK proofs or access PER enclave internals.

**Class D — Compromised single validator**
Controls one node on the IKA MPC network or the Encrypt threshold network. Cannot complete a threshold operation alone — both require 2/3 consensus.

**Class E — MagicBlock PER operator**
Runs the Intel TDX enclave. Cannot access enclave memory from outside (hardware attestation). Can observe that TX1 funded the relay and that TX2 committed a batch — but cannot link individual users to individual commitments within the batch.

ShieldLend's threat model assumes adversaries up to and including Class C. Class D and E represent trust assumptions disclosed in the pre-alpha status table.

---

## Unlinkability Analysis — Per Flow

### Deposit Unlinkability

**Goal**: No observer can link a specific user wallet to a specific commitment in the Merkle tree.

**Attack surface**:
1. TX1 (user → relay): visible. Shows user wallet and amount.
2. TX2 (relay → ShieldedPool): visible. Shows relay wallet, not user.
3. Timing correlation: if TX1 and TX2 are 1:1, an observer can link them by time proximity.

**Mitigations**:
- MagicBlock PER batches multiple TX1 deposits before emitting a single TX2. The batch contains commitments from multiple users. An observer cannot determine which commitment in the batch belongs to which user in TX1 without breaking the enclave.
- The IKA relay wallet is shared across all users. TX1 destinations are indistinguishable.
- VRF dummy insertions add commitments with no corresponding TX1. The anonymity set includes real + dummy commitments. An observer cannot distinguish them.

**Residual risk**: If only one user deposits in a long period, the batch may contain only one real commitment. Dummy insertions mitigate but do not eliminate this — a fully determined adversary observing a quiescent pool may reduce the anonymity set. Mitigation: minimum batch size before flush (configurable parameter).

---

### Withdrawal Unlinkability

**Goal**: No observer can determine (a) which commitment was spent, (b) who submitted the ring proof transaction, or (c) who received the funds.

**Attack surface**:
1. Ring membership is public (ring[16] in public outputs).
2. nullifierHash is public — prevents double-spend but does not reveal which commitment.
3. The ring proof transaction signer is permanently on-chain.
4. Withdrawal destination (stealth address) is public.

**Mitigations**:
- Relay routing: the user sends the ring proof off-chain to the IKA relay. The relay submits the on-chain transaction — the relay wallet is the permanent on-chain signer, not the user's wallet. This prevents linking a user's wallet to any set of 16 ring candidates.
- Ring proof (K=16): the spent commitment is one of 16. An observer knows only which ring was used — not which element was spent. For a pool with N commitments, the probability of correctly guessing the spender is 1/16 per ring.
- The ring is selected from across the entire Merkle tree, including VRF dummy commitments. Dummies are indistinguishable from real commitments in the ring — they expand the effective anonymity set beyond K=16.
- Unified exit path: withdrawal exits are queued in the same PER batch as borrow disbursement exits. An observer sees "relay sent SOL to stealth addresses" — and cannot classify whether each exit is a withdrawal or a borrow disbursement.
- Umbra stealth address: the withdrawal destination is a fresh address with zero prior history, generated via ECDH from the recipient's stealth meta-address. Only the recipient can derive the private key.

**Residual risk**: If an adversary can observe the recipient sweep from the stealth address to a known wallet, they learn the final destination. Mitigation: recipient sweeps via a separate mixer or delayed transfer (user responsibility post-exit).

---

### Borrow Unlinkability

**Goal**: No observer can link (a) which commitment is being used as collateral, or (b) which wallet is the borrower.

**Attack surface**:
1. Collateral ring[16] is public — same analysis as withdrawal.
2. Loan disbursement recipient is a public field in the borrow transaction.
3. LoanAccount PDA is public — its existence signals a loan is active.
4. Borrow amount is a ZK public input — visible on-chain.

**Mitigations**:
- Ring proof hides which commitment is collateral (same K=16 + VRF dummy analysis as withdrawal).
- Collateral nullifier is locked (not spent) — the commitment remains in the Merkle tree and can appear in other users' rings. This prevents the "process of elimination" attack where an observer flags an absent commitment.
- Relay routing for borrow submission: the relay wallet is the on-chain signer, not the borrower's wallet. The borrower's address is a private input to the collateral_ring circuit — never published on-chain.
- Unified exit path: borrow disbursements exit via the same relay → PER → Umbra stealth path as withdrawals. Both exit types are indistinguishable on-chain.
- Umbra stealth address for disbursement: the borrower's receiving address has no prior history.

**Residual risk**: The LoanAccount PDA is created when a borrow occurs. An observer can count active loans and infer protocol utilization — but not who borrowed or which commitment is collateral.

---

### Repay Unlinkability

**Goal**: No observer can determine who repaid a loan or confirm a specific identity was a borrower.

**Attack surface**:
1. Repay transaction must reference a loanId to clear the correct PDA.
2. Repayment value must reach the repayment vault or private balance.
3. A normal public repayment transfer would reveal amount and transfer graph.

**Mitigations**:
- repay_ring proof: proves knowledge of the collateral nullifier without revealing the borrower's wallet and binds the repay attempt to `loanId`, `nullifierHash`, `outstanding_balance`, and a private payment receipt hash.
- Outstanding balance is computed on-chain from the public Kamino rate history and passed as a ZK public input. Lending accounting remains deterministic.
- In Full Privacy mode, repayment value settles through MagicBlock Private Payments. The LendingPool verifies the private payment receipt before unlocking collateral, avoiding a plain public transfer to ShieldedPool.
- In degraded mode, repayment can still route through the IKA relay for identity privacy. In that path, repayment amount privacy is not claimed.
- loanId is the only public link — it identifies which PDA to close. It does not identify the borrower.
- After repay, the LoanAccount PDA is closed. The collateral nullifier is unlocked and the note is withdrawable. No on-chain trace connects the repayment event to the original depositor's wallet.

---

## VRF Dummy Indistinguishability

VRF dummy commitments must be computationally indistinguishable from real commitments. This is a security property, not just an operational requirement.

**Real commitment**: `Poseidon(secret, nullifier, denomination)` where `secret` and `nullifier` are 256-bit randoms generated client-side and never published.

**VRF dummy commitment**: `Poseidon("SHIELDLEND_DUMMY", pool_id, epoch_id, dummy_index, magicblock_vrf_output, enclave_private_entropy)`.

**Property**: A polynomial-time adversary who sees the on-chain VRF proof cannot distinguish a dummy commitment from a real commitment because the dummy preimage includes enclave-private entropy and is discarded after insertion. MagicBlock VRF supplies unbiasable epoch randomness; the PER/TEE prevents observers from recomputing dummy leaves.

**Guarantee this provides**: When VRF dummies appear in a ring alongside real commitments, the adversary cannot label which ring members are dummies. The effective anonymity set is truly K=16 (not K = number of real commitments).

---

## Double-Spend Prevention

The NullifierRegistry PDA is the single source of truth for whether a note has been used:

```
withdraw:  Active → Spent    (note consumed; cannot withdraw again)
borrow:    Active → Locked   (note locked; cannot withdraw while loan active)
repay:     Locked → Active   (note released; can now withdraw)
liquidate: Locked → Spent    (note consumed by liquidation)
```

The ZK circuit computes `nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)` where `nullifier` and `leaf_index` are private inputs and the program id is a circuit constant. The on-chain program checks `NullifierAccount(nullifierHash).status`. A forged proof that uses a valid nullifierHash but wrong nullifier is computationally infeasible — Poseidon is collision-resistant in the BN254 field.

---

## Encrypted Oracle Attack Prevention

Standard oracle attacks on lending protocols:
1. Observer sees a large price drop incoming
2. Observer front-runs the health_factor breach to avoid liquidation or force liquidation on others

ShieldLend's mitigation: price feeds are submitted as Encrypt FHE ciphertext inputs. The `health_factor` computation runs homomorphically on encrypted values. No observer — including MEV bots — can see the price feed before the `liquidate` transaction confirms. The health_factor result is also a ciphertext until threshold decryption is requested for a specific loan.

---

## Aggregate Solvency Without Individual Exposure

Protocol solvency requires knowing aggregate collateral coverage without revealing individual collateral positions:

```
total_collateral_value = Σ(encrypted_collateral_value[i])   // FHE homomorphic addition
total_outstanding = Σ(public_or_bucketed_borrow_amount[i])  // public accounting
```

FHE homomorphic addition preserves the encryption — the sum is still a ciphertext. A single threshold decryption of the sum reveals only aggregate collateral coverage. Individual encrypted collateral values remain ciphertext throughout. Borrow amounts are public or bucketed in the MVP so LTV, interest, reserves, and liquidation remain mechanically verifiable.

The solvency invariant monitored: `total_outstanding ≤ aggregate_collateral_value × max_ltv`.

---

## Nullifier Security Properties

### Position-Dependent Binding
`nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)`

**Why leaf_index is required**: If a commitment were re-inserted at a different tree position, the old formula `Poseidon(nullifier)` would produce the same nullifierHash regardless of position. A note spent at position 5 would have the same nullifier record as a freshly inserted copy at position 1000. Including `leaf_index` binds the spent record to the specific position — re-insertion at any other position produces a different nullifierHash and would not conflict with the existing spent record.

*Inspired by Penumbra's position-dependent nullifier: `nf = Poseidon(domain_sep, nullifier_key, commitment, position_in_tree)`*

### App-Siloed Domain Separation
`SHIELDED_POOL_PROGRAM_ID` as domain separator prevents cross-contract nullifier correlation. If ShieldLend ever deploys a V2 or complementary protocol with its own nullifier registry, notes cannot be linked across registries by comparing nullifierHash values.

*Inspired by Aztec's app-siloed nullifier keys: `nullifier_app = Poseidon(nsk_master, app_contract_address)`*

---

## Accepted Disclosures and Residual Risks

### Accepted Disclosures (visible by design)
These properties are intentionally public — required by the ZK circuit design or the lending protocol mechanics:

| Disclosure | Why public | Inference possible |
|---|---|---|
| Borrow amount or bucket | ZK public input — required for on-chain LTV, interest, reserve, and liquidation mechanics | Denomination range inferable; amount fingerprinting reduced by buckets |
| That a borrow occurred | LoanAccount PDA creation visible | Loan count is enumerable |
| Denomination class on withdrawal | ZK public output — required for correct SOL release | None — denomination is fixed, not identity-linking |
| Aggregate collateral coverage | Threshold decryption product — one value revealed | Protocol solvency status only |
| Repayment amount in degraded mode | Normal relay transfer fallback if private payments unavailable | Amount visible; borrower identity still protected by relay + proof |

### Residual Risks (mitigated but not eliminated)

| Risk | Mitigation | Residual exposure |
|---|---|---|
| Timing correlation on small pool | `min_real_deposits_before_flush = 8`, PER batching delay | Quiescent pool window may narrow anonymity |
| Stealth address sweep deanonymization | None (user responsibility) | Post-exit sweep to known wallet creates on-chain link |
| IP address exposure to IKA relay | None (user responsibility — use Tor/VPN) | Relay operator sees IP of proof submitter |
| Single oracle epoch manipulation | `consecutive_breach_count >= 2`, `max_oracle_deviation_bps = 20%` | Two consecutive manipulated epochs could trigger liquidation |
| PER operator timing visibility | Intel TDX hardware attestation | Operator knows batch timing, not individual user→commitment links |
| Amount fingerprinting | Fixed denominations + borrow buckets | Repeated unique amounts may still weaken anonymity |
| Private payment receipt replay | Receipt binds loanId, nullifierHash, outstanding_balance, vault, epoch | Incorrect binding would allow collateral unlock without valid settlement |

### Out-of-Scope Privacy Properties
The following are explicitly not protected by the protocol:

- **IP address privacy**: The IKA relay operator sees the IP address of the user submitting proofs. Users requiring IP privacy must use Tor or VPN at the application layer.
- **Post-exit fund movement**: If a user forwards funds from their Umbra stealth address to a known wallet, that on-chain link is permanent. The protocol cannot prevent this.
- **OFAC compliance proofs**: Currently no mechanism to prove deposits didn't originate from sanctioned addresses. *Roadmap: Railgun's Proof of Innocence pattern — ZK proof of non-inclusion in OFAC SDN list without identity reveal.*

---

## Trust Assumptions Summary

| Component | Trust assumption | Consequence if broken |
|---|---|---|
| MagicBlock PER Intel TDX | Enclave not compromised | Deposit→commitment mapping exposed |
| MagicBlock Private Payments | Private payment settlement and receipt verification are sound | Repayment amount/transfer graph privacy or collateral unlock safety can fail |
| IKA MPC network (2/3) | Not all validators collude | Unauthorized disbursement possible |
| Encrypt threshold network (2/3) | Not all validators collude | Aggregate balance sum exposed to a single party |
| Umbra SDK key derivation | ECDH not broken | Stealth address ownership linked |
| groth16-solana BN254 | Discrete log hard on BN254 | ZK proofs forgeable |
| Poseidon hash | Collision resistance | Commitment collision, nullifier forgery |
| MagicBlock VRF | VRF not manipulable by requester | Dummy insertion predictable |

All cryptographic assumptions (BN254 DL, Poseidon collision resistance) are standard in ZK protocol design as of 2026. The MPC threshold assumptions (IKA, Encrypt) require 2/3 consensus to break — a single compromised party cannot act alone.
