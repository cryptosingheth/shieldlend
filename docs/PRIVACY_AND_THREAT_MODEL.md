# ShieldLend - Privacy and Threat Model

This document is the canonical privacy and security model for ShieldLend Solana. It explains what the protocol hides, what it intentionally leaves public for lending safety, which adversaries are considered, and how the selected protocols defend each flow.

## 1. Privacy Goals

ShieldLend is designed so a third-party observer cannot build a wallet-level credit profile from deposit, borrow, repay, and withdraw activity.

| Protected fact | Protection goal |
|---|---|
| Depositor wallet -> pool commitment | A deposit funding wallet should not map to a specific Merkle tree leaf. |
| Commitment -> withdrawal destination | Spending a note should not reveal which deposit created it. |
| Collateral note -> borrower wallet | A loan should not reveal which deposited note backs it or who owns it. |
| Borrow disbursement destination | Loan proceeds should arrive at a fresh address with no visible wallet history. |
| Repayer wallet -> loan closure | Repayment should not confirm that a known wallet was the borrower. |
| Repayment transfer graph in Full Privacy mode | A normal public repayment transfer should not reveal payer, amount path, and loan closure. |
| Oracle/health computation | Liquidation-sensitive price and health data should not be readable in the mempool. |
| User history | Transaction history should be user-controlled, not protocol-indexed. |

Borrow amount is public or bucketed in the MVP. This is an accepted lending-safety disclosure: LTV checks, interest accrual, reserves, bad-debt controls, and liquidation thresholds must remain deterministic. Public or bucketed borrow amount can leak amount metadata, but it does not by itself link a borrower to the original depositor because collateral identity, borrower wallet, and disbursement destination are protected by separate layers.

## 2. Privacy Architecture By Flow

### Deposit

Goal: prevent a public funding wallet from being linked to a specific pool commitment.

Mechanisms:
- The user creates the note secret, nullifier, denomination, and commitment locally.
- IKA submits the pool-facing transaction, so the user wallet is not the ShieldedPool signer.
- MagicBlock PER batches multiple deposits before commitments are inserted into the Merkle tree.
- MagicBlock VRF plus PER/TEE private entropy creates dummy commitments that observers cannot distinguish from real commitments.

What remains public:
- A wallet funded a relay.
- The relay inserted a batch.
- Denomination classes exist.

What is hidden:
- Which relay funding event produced which commitment.
- Which commitments are real and which are dummies.

### Withdrawal

Goal: prevent the withdrawal from revealing the original depositor, the spent commitment, or the final receiving wallet.

Mechanisms:
- A Groth16 ring proof proves ownership of one commitment without revealing which member was spent.
- The nullifier prevents double-spend without revealing the note secret.
- IKA submits the withdrawal, so the user's wallet is not the on-chain signer.
- MagicBlock PER batches withdrawals with borrow disbursement exits.
- Umbra generates a fresh stealth address for the receiving side.

What remains public:
- A relay submitted a withdrawal proof.
- A nullifier hash was marked spent.
- A fixed denomination was released.

What is hidden:
- Which ring member was the user's commitment.
- Which user submitted the proof.
- Whether an exit is a withdrawal or borrow disbursement when it is batched with other exits.
- Which known wallet controls the receiving address.

### Borrow

Goal: allow lending against shielded collateral without revealing the collateral note or borrower wallet.

Mechanisms:
- The collateral circuit proves the user owns a valid note and that the borrow amount satisfies the collateral ratio.
- The collateral nullifier moves from Active to Locked, preventing withdrawal while the loan is active.
- IKA submits the borrow transaction and co-signs disbursement only after program-side checks pass.
- MagicBlock PER batches disbursement exits with withdrawals.
- Umbra provides a fresh stealth address for loan proceeds.

What remains public:
- A LoanAccount PDA exists.
- Borrow amount is public or bucketed.
- The loan is active until repaid or liquidated.

What is hidden:
- Which note was locked as collateral.
- Which wallet owns the note.
- Which known wallet receives the loan proceeds.

### Repay

Goal: unlock collateral only after sufficient repayment while protecting borrower identity and, in Full Privacy mode, avoiding a public repayment transfer graph.

Mechanisms:
- `repay_ring` proves knowledge of the locked collateral nullifier.
- The proof binds the repayment to `loanId`, `nullifierHash`, `outstanding_balance`, and `settlementReceiptHash`.
- MagicBlock Private Payments is the Full Privacy settlement rail; the LendingPool verifies the private payment receipt before unlocking collateral.
- IKA submits the repay instruction, so the borrower wallet is not the on-chain signer.

What remains public:
- The loanId being closed.
- The outstanding balance used by the program for deterministic accounting.
- The nullifier state transition from Locked to Active.

What is hidden in Full Privacy mode:
- The borrower wallet.
- The payment path.
- The normal public payer-to-vault repayment transfer graph.

Degraded mode:
- If MagicBlock Private Payments is unavailable, repayment can still route through IKA for identity privacy, but repayment amount privacy must not be claimed.

### Liquidation

Goal: preserve bad-debt protection while avoiding public health-factor leakage and preventing unfair liquidation.

Mechanisms:
- Encrypt FHE keeps oracle price and health computation encrypted.
- Breach confirmation requires consecutive unhealthy epochs before liquidation can proceed.
- Handle pinning binds an Encrypt liquidation reveal to the exact LoanAccount PDA.
- IKA FutureSign executes the borrower-consented liquidation only after the confirmed condition is met.
- MVP liquidation is full liquidation only, with conservative LTV, stale-oracle pause, minimum borrow size, and reserve accounting.

What remains public:
- A loan is liquidated.
- A nullifier moves from Locked to Spent.
- Reserve and liquidation accounting are visible enough for solvency checks.

What is hidden:
- The borrower wallet.
- The original collateral note identity.
- Health computation before authorized reveal.

### User History and Disclosure

Goal: give users usable records without creating a protocol-wide viewing key.

Mechanisms:
- The frontend stores encrypted local history records derived from the user's wallet key material.
- Each record can include operation type, tx signature, Merkle root, nullifier hash, proof public signal hash, private payment receipt hash, and display metadata.
- A user can export a scoped disclosure packet for selected records only.

There is no protocol operator viewing key and no global deanonymization key.

## 3. Adversary Classes

| Class | Capabilities | Primary defenses |
|---|---|---|
| Passive on-chain observer | Reads all transactions, accounts, logs, and public state. | ZK proofs, relay signer privacy, PER batching, Umbra stealth addresses, FHE ciphertexts. |
| Active chain participant | Submits transactions, attempts front-running or spam. | On-chain proof verification, state checks, fees, breach confirmation. |
| Malicious relay operator | Sees relay requests and IP metadata; can delay or censor. | IKA 2PC-MPC, proof-gated state transitions, alternate relay path, no unilateral fund control. |
| Compromised single IKA or Encrypt validator | Sees one shard of threshold computation. | Threshold cryptography; one party cannot decrypt or sign alone. |
| MagicBlock PER operator | Observes batch timing and aggregate batch size. | Intel TDX enclave isolation and attestation; no access to enclave-internal mapping. |
| Encrypt FHE committee majority | Could decrypt protected values if threshold is compromised. | Explicit trust assumption; only targeted/aggregate reveals should be authorized. |

IP privacy is not enforced by ShieldLend. Users who need network-layer privacy must use Tor, VPN, or a privacy-preserving relay network.

## 4. Privacy Property Table

| Property | Status | Mechanism |
|---|---|---|
| Depositor wallet hidden from ShieldedPool | Protected | IKA relay signs pool-facing transactions. |
| Deposit-to-commitment mapping | Protected | MagicBlock PER batching inside TDX. |
| Deposit timing correlation | Mitigated | Minimum batch sizes and PER epoch delays. |
| VRF dummies indistinguishable | Protected | MagicBlock VRF plus PER private entropy; dummy preimages discarded. |
| Which commitment was spent | Protected | Groth16 ring proof over K candidates plus dummies. |
| Cross-contract nullifier correlation | Protected | `SHIELDED_POOL_PROGRAM_ID` in nullifier formula. |
| Re-insertion double-spend | Protected | `leaf_index` in nullifier formula. |
| Withdrawal submitter wallet | Protected | IKA relay submits proof transaction. |
| Withdrawal destination | Protected | Umbra fresh stealth address. |
| Exit type classification | Mitigated | Withdrawal and disbursement exits share PER -> Umbra path. |
| Collateral note identity | Protected | Collateral ring proof. |
| Borrower wallet | Protected | Private circuit input plus relay signer. |
| Disbursement destination | Protected | Umbra stealth address. |
| Repayer wallet | Protected | IKA relay plus repay proof. |
| Repayment transfer graph | Protected in Full Privacy mode | MagicBlock Private Payments receipt binding. |
| Repayment amount | Mode-dependent | Hidden only when private payment settlement is active. |
| Oracle price and health computation | Protected | Encrypt FHE ciphertext computation. |
| Individual collateral health values | Protected until authorized reveal | Encrypt FHE and threshold decryption. |
| Aggregate collateral coverage | Intentionally disclosed | Threshold decrypt aggregate only, not individual values. |
| Borrow amount | Public or bucketed | Required for deterministic lending mechanics. |
| Loan existence/count | Public | LoanAccount PDA creation is visible. |
| Post-exit movement | Out of scope | User can deanonymize themselves by sweeping to a known wallet. |

## 5. Attack Scenarios and Mitigations

### Timing Correlation

Attack: an observer links a user relay-funding transaction to a pool commitment by timestamp.

Mitigation:
- PER batch processing.
- Minimum real deposits before flush.
- VRF dummies that add non-user commitments.
- Relay address shared across users.

Residual risk: a quiet pool can still reduce the practical anonymity set. The frontend should make degraded or low-liquidity privacy status visible.

### Ring Membership Reduction

Attack: an observer tracks nullified commitments and tries to shrink the ring candidate set.

Mitigation:
- Ring members are proved in ZK.
- Dummy commitments persist and cannot be labeled by observers.
- Historical roots allow proofs against recent roots rather than forcing the newest tree only.

Residual risk: amount and timing metadata can still weaken privacy in small pools.

### Public Borrow Amount Fingerprinting

Attack: an observer uses public or bucketed borrow amounts to infer possible collateral denomination.

Mitigation:
- Borrow buckets reduce uniqueness.
- Collateral note identity remains hidden by the ring proof.
- Borrower wallet is hidden by relay submission.
- Loan proceeds use the same PER -> Umbra exit path as withdrawals.

Residual risk: amount metadata remains visible by design in the MVP.

### Private Payment Receipt Replay

Attack: a borrower or attacker reuses a valid private payment receipt for another loan or for a stale lower outstanding balance.

Mitigation:
- Receipt hash binds `loanId`, `nullifierHash`, `outstanding_balance`, `repayment_vault`, and epoch or nonce.
- LendingPool recomputes outstanding balance at repay time.
- `repay_ring` binds the collateral nullifier to the same receipt.
- Receipt nonce is consumed after successful repayment.

### Oracle Manipulation

Attack: a manipulated or stale oracle update triggers liquidation of a healthy position.

Mitigation:
- Encrypt FHE prevents public pre-confirmation health-factor calculation.
- Liquidation requires consecutive breach confirmations.
- Large price moves pause liquidation for an epoch.
- Stale liquidation flags are cleared on repay or future collateral improvement.

### FHE Reveal Replay

Attack: a decryption proof for one loan is submitted against another loan.

Mitigation:
- Liquidation reveal proof is bound to the specific LoanAccount PDA.
- PDA seed includes `collateral_nullifier_hash`.
- The stored ciphertext handle must match the revealed handle.

### Stealth Address Sweep Deanonymization

Attack: a user forwards funds from a stealth address to a known wallet.

Mitigation:
- The protocol cannot prevent this.
- Frontend must warn users that sweeping to a known wallet creates a permanent public link.
- Safer options are delayed use, continued use of the stealth wallet, re-deposit, or transfer through a separate privacy tool.

### PER Liveness Failure

Attack or failure: MagicBlock PER is unavailable and exits cannot batch.

Mitigation:
- Degraded Privacy mode enables direct relay/proof withdrawals with reduced privacy claims.
- Emergency mode can prioritize fund recovery through governance if multiple dependencies fail.
- UI must clearly show privacy mode before users transact.

## 6. Trust Assumptions

| Component | Assumption | Failure consequence |
|---|---|---|
| groth16-solana and BN254 | Proof system remains sound. | Invalid proofs could pass. |
| Poseidon | Collision resistance holds. | Commitment or nullifier forgery risk. |
| Circom/Groth16 setup | Toxic waste not retained. | Fake proofs possible for affected circuit. |
| MagicBlock PER / TDX | Enclave isolation and attestation hold. | Deposit-to-commitment mapping may be exposed. |
| MagicBlock VRF | Randomness is unpredictable and unbiasable. | Dummy placement could be manipulated. |
| MagicBlock Private Payments | Private settlement receipts are sound and anti-replay. | Repayment privacy or collateral unlock safety could fail. |
| IKA dWallet | Threshold signing cannot be completed by one operator. | Unauthorized relay signing risk if threshold breaks. |
| IKA FutureSign | Conditional execution is enforced correctly. | Liquidation could fail or execute incorrectly. |
| Encrypt FHE | Ciphertexts and threshold decryption are sound. | Oracle, health, or aggregate confidentiality could fail. |
| Umbra SDK | Stealth key derivation is correct. | Output ownership could become linkable. |

## 7. Accepted MVP Disclosures

These disclosures are intentional, documented, and required for a safe first version:

- Borrow amount is public or bucketed.
- LoanAccount creation and loan count are public.
- Denomination class is visible when fixed-denomination funds are released.
- Aggregate collateral coverage can be threshold-decrypted.
- Repayment amount is private only in Full Privacy mode with MagicBlock Private Payments.
- IP address privacy is not handled by the protocol.
- Post-exit wallet behavior is user responsibility.

## 8. Out Of Scope For MVP

- Fully private borrow amount and fully private debt accounting.
- Under-collateralized credit tiering.
- Proof of innocence / sanctions non-inclusion.
- Dummy LoanAccount PDAs to hide loan count.
- Protocol-enforced IP metadata privacy.
- Partial liquidation.
