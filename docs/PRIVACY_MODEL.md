# ShieldLend — Privacy Model and Threat Analysis

---

## What ShieldLend Protects

ShieldLend is a lending protocol where the following facts must be unobservable to any external party — including chain validators, relay operators, and other protocol users:

| Protected fact | Why it matters |
|---|---|
| Which wallet deposited | Prevents building profiles of depositors |
| Which commitment corresponds to which depositor | Prevents tracing withdrawal back to deposit |
| Who is the borrower behind a loan | Prevents identity-linked credit profiling |
| Loan amount and interest balance | Prevents on-chain net worth inference |
| Who repaid a loan | Prevents confirmation of identity |
| Where funds went after withdrawal or disbursement | Prevents tracking funds post-exit |

---

## Threat Model

### Adversary Classes

**Class A — Passive on-chain observer**
Reads all transactions, account states, event logs. Cannot decrypt encrypted accounts. Cannot access enclave-internal state. Most realistic adversary.

**Class B — Active chain participant**
Controls one or more wallets. Can submit transactions, watch mempool. Cannot break cryptographic commitments or forge ZK proofs.

**Class C — Malicious relay operator**
Controls the IKA relay wallet used for deposit and repay routing. Can observe the user→relay transaction (TX1). Cannot forge ZK proofs or access PER enclave internals.

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

**Goal**: No observer can determine (a) which commitment was spent, or (b) who received the funds.

**Attack surface**:
1. Ring membership is public (ring[16] in public outputs).
2. nullifierHash is public — prevents double-spend but does not reveal which commitment.
3. Withdrawal destination (stealth address) is public.

**Mitigations**:
- Ring proof (K=16): the spent commitment is one of 16. An observer knows only which ring was used — not which element was spent. For a pool with N commitments, the probability of correctly guessing the spender is 1/16 per ring.
- The ring is selected from across the entire Merkle tree, including dummy commitments. Dummies are indistinguishable from real commitments in the ring — they expand the effective anonymity set beyond K=16.
- Umbra stealth address: the withdrawal destination is a fresh address with zero prior history. It is generated via ECDH from a published stealth meta-address — only the recipient can derive the private key. After the Umbra SDK sweeps funds to the user's wallet, the stealth address is abandoned and never reused.

**Residual risk**: If an adversary can observe the recipient sweep from the stealth address to a known wallet, they learn the final destination. Mitigation: recipient sweeps via a separate mixer or delayed transfer (user responsibility post-exit).

---

### Borrow Unlinkability

**Goal**: No observer can link (a) which commitment is being used as collateral, or (b) which wallet is the borrower.

**Attack surface**:
1. Collateral ring[16] is public — same analysis as withdrawal.
2. Loan disbursement recipient is a public field in the borrow transaction.
3. LoanAccount PDA is public — its existence signals a loan is active.

**Mitigations**:
- Ring proof hides which commitment is collateral (same K=16 analysis).
- Collateral nullifier is locked (not spent) — the commitment remains in the Merkle tree and can appear in other users' rings. This prevents the "process of elimination" attack where an observer flags an absent commitment.
- Umbra stealth address for disbursement: the borrower's receiving address has no prior history.
- IKA dWallet: the disbursement transaction is signed by the IKA relay program, not the borrower's wallet. The borrower's address is a private input to the collateral_ring circuit — never published on-chain.
- Encrypt FHE: the loan amount in LoanAccount is a ciphertext. An observer sees a PDA was created but cannot read the amount.

**Residual risk**: The LoanAccount PDA is created when a borrow occurs. An observer can count active loans and infer protocol utilization — but not who borrowed or how much.

---

### Repay Unlinkability

**Goal**: No observer can determine who repaid a loan or confirm a specific identity was a borrower.

**Attack surface**:
1. Repay transaction must reference a loanId to clear the correct PDA.
2. Repayment SOL must reach ShieldedPool.

**Mitigations**:
- repay_ring proof: proves knowledge of the collateral nullifier (only the borrower knows it) + repaymentAmount ≥ totalOwed, without revealing the borrower's wallet. The wallet is a private input.
- Repayment SOL flows via the IKA relay — same path as deposit traffic. An observer sees "relay received SOL and cleared a loan PDA" — identical to a deposit in terms of relay traffic analysis.
- loanId is the only public link — it identifies which PDA to close. It does not identify the borrower.
- After repay, the LoanAccount PDA is closed. The collateral nullifier is unlocked and the note is withdrawable. No on-chain trace connects the repayment event to the original depositor's wallet.

---

## Double-Spend Prevention

The NullifierRegistry PDA is the single source of truth for whether a note has been used:

```
withdraw: Active → Spent    (note consumed; cannot withdraw again)
borrow:   Active → Locked   (note locked; cannot withdraw while loan active)
repay:    Locked → Active   (note released; can now withdraw)
liquidate: Locked → Spent   (note consumed by liquidation)
```

The ZK circuit computes `nullifierHash = Poseidon(nullifier)` where `nullifier` is a private input only the depositor knows. The on-chain program checks `NullifierAccount(nullifierHash).status`. A forged proof that uses a valid nullifierHash but wrong nullifier is computationally infeasible — Poseidon is collision-resistant in the BN254 field.

---

## Encrypted Oracle Attack Prevention

Standard oracle attacks on lending protocols:
1. Observer sees a large price drop incoming
2. Observer front-runs the health_factor breach to avoid liquidation or force liquidation on others

ShieldLend's mitigation: price feeds are submitted as FHE ciphertext inputs. The `health_factor` computation runs homomorphically on encrypted values. No observer — including MEV bots — can see the price feed before the `flush_epoch` or `liquidate` transaction confirms. The health_factor result is also a ciphertext until the ER liquidation bot requests threshold decryption for a specific loan.

---

## Aggregate Solvency Without Individual Exposure

Protocol solvency requires knowing total outstanding debt without revealing individual loan amounts:

```
total_outstanding = Σ(encrypted_balance[i])   // FHE homomorphic addition
```

FHE homomorphic addition preserves the encryption — the sum is still a ciphertext. A single threshold decryption of the sum reveals only `total_outstanding`. Individual `encrypted_balance[i]` values remain ciphertext throughout.

The ER liquidation bot monitors: `total_outstanding ≤ shielded_pool.lamports × LTV_FLOOR`. If this invariant is breached (e.g., a market crash causes widespread undercollateralization), the bot triggers emergency pause.

---

## Trust Assumptions Summary

| Component | Trust assumption | Consequence if broken |
|---|---|---|
| MagicBlock PER Intel TDX | Enclave not compromised | Deposit→commitment mapping exposed |
| IKA MPC network (2/3) | Not all validators collude | Unauthorized disbursement possible |
| Encrypt threshold network (2/3) | Not all validators collude | Loan balances exposed |
| Umbra SDK key derivation | ECDH not broken | Stealth address ownership linked |
| groth16-solana BN254 | Discrete log hard on BN254 | ZK proofs forgeable |
| Poseidon hash | Collision resistance | Commitment collision, nullifier forgery |
| MagicBlock VRF | VRF not manipulable by requester | Dummy insertion predictable |

All cryptographic assumptions (BN254 DL, Poseidon collision resistance) are standard in ZK protocol design as of 2026. The MPC threshold assumptions (IKA, Encrypt) require 2/3 consensus to break — a single compromised party cannot act alone.
