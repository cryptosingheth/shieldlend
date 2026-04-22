# ShieldLend — Explicit Threat Model

*Every production privacy protocol publishes an explicit threat model before implementation. This document defines exactly who can observe what, which layer defends against which adversary, and what is explicitly out of scope.*

---

## 1. Adversary Classes

### Class A — Passive On-Chain Observer
**Capabilities**: Reads all transactions, account states, event logs, mempool. Cannot decrypt Encrypt FHE ciphertexts. Cannot access MagicBlock PER enclave internals. Cannot break ZK proofs.

**Examples**: Blockchain analytics firms, competing protocols, anyone running a Solana RPC node.

**This is the primary adversary.** Most realistic, most capable non-cryptographic attacker.

---

### Class B — Active Chain Participant
**Capabilities**: Everything Class A can do, plus: can submit transactions, attempt front-running, watch for specific account changes.

**Additional risk**: Can attempt to grief the protocol by submitting invalid proofs, spam deposits, or time liquidation attempts to coincide with oracle updates.

**Defense**: ZK proof validity is mandatory before any state change. Invalid proofs are rejected on-chain with no state change. Fee for proof submission discourages spam.

---

### Class C — Malicious IKA Relay Operator
**Capabilities**: Receives user-submitted ZK proofs and relay requests (off-chain). Sees user IP addresses and the proof payload. Signs and submits on-chain transactions as the relay wallet.

**What they can do**: Censor specific deposits, withdrawals, or borrows (refuse to relay). Delay exits. See that specific IP addresses are using the protocol.

**What they cannot do**: Forge ZK proofs. Access MagicBlock PER enclave. Steal funds (cannot disburse without IKA MPC co-signature). Link a commitment to a specific user — only the enclave knows this.

**Defense**: IKA 2PC-MPC — no single relay operator key exists. The relay wallet requires both user partial signature AND IKA MPC network co-signature for any operation. If the relay operator attempts to censor, the user's partial signature is valid and can be submitted through any other relay infrastructure.

**Trust assumption**: IKA MPC network does not collude with the relay operator. 2/3 MPC threshold required.

---

### Class D — Compromised Single MPC Validator (IKA or Encrypt)
**Capabilities**: Controls one node on either the IKA MPC network or the Encrypt FHE threshold decryption network.

**What they can do**: Observe their shard of the computation. Attempt to correlate shards across operations.

**What they cannot do**: Complete a threshold operation alone — 2/3 consensus required. Decrypt individual Encrypt FHE ciphertexts without majority cooperation.

**Defense**: Threshold cryptography. Breaking either network requires compromising 2/3 of independent validators simultaneously.

---

### Class E — MagicBlock PER Operator
**Capabilities**: Runs the Intel TDX enclave that processes deposit batches and exit batches. Observes that TX1 (user→relay funding) occurred and that TX2 (batch→ShieldedPool) occurred.

**What they can do**: Know the aggregate batch composition (how many deposits in a batch). Observe timing of batches.

**What they cannot do**: Read enclave memory (hardware attestation prevents this). Link a specific TX1 to a specific commitment in the TX2 batch. See which user funded which commitment.

**Defense**: Intel TDX hardware attestation. Even if the PER operator is malicious, the enclave's memory is sealed by the CPU.

**Trust assumption**: Intel TDX hardware is not backdoored. The TDX attestation key has not been compromised.

---

### Class F — Encrypt FHE Oracle Committee (2/3 of 3)
**Capabilities**: The oracle committee submits encrypted price feeds and participates in threshold decryption of health factors.

**What they can do**: Collectively know oracle prices (they encrypt them). Collectively participate in threshold decryption to reveal aggregate outstanding debt or individual loan health factors.

**What they cannot do**: A single member cannot decrypt anything alone. Two members cannot reveal data without the third's participation in a 2-of-3 scheme.

**Defense**: Threshold decryption minimum threshold is 2/3. Encrypt FHE network provides the threshold key material.

---

## 2. Privacy Guarantees — Full Property Table

```
PROPERTY                                    STATUS     MECHANISM                              ADVERSARY DEFENDED AGAINST
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Depositor wallet hidden from ShieldedPool   ✓          IKA relay is TX2 signer                Class A, B, C
Deposit→commitment linking prevented        ✓          MagicBlock PER Intel TDX batch         Class A, B, E
Deposit timing correlation broken           ✓          PER temporal batching                  Class A, B
Anonymity set ≥ 8 real (min batch)          ✓          min_real_deposits_before_flush = 8     Class A, B
VRF dummies indistinguishable from real     ✓          Poseidon(vrf_output, denomination)     Class A, B
Anonymity set grows over time               ✓          VRF dummies persist in Merkle tree     Class A, B
Historical root access (30 epochs)          ✓          Root ring buffer in ShieldedPoolState  Class A, B
Withdrawal submitter wallet hidden          ✓          IKA relay is TX signer                 Class A, B
Which commitment was spent                  ✓          Ring proof K=16 + VRF dummies          Class A, B
Cross-contract nullifier unlinkability      ✓          nullifierHash includes PROGRAM_ID      Class A, B
Re-insertion double-spend prevention        ✓          nullifierHash includes leaf_index      Class A, B
Withdrawal destination hidden               ✓          Umbra stealth address (ECDH)           Class A, B
Exit type (withdrawal vs borrow)            ✓          Unified PER exit batch                 Class A, B
Collateral identity (which note)            ✓          Collateral ring proof K=16             Class A, B
Borrower wallet hidden                      ✓          ZK private input + relay signer        Class A, B
Disbursement destination hidden             ✓          Umbra stealth address                  Class A, B
Repayment amount                            ✓          ZK private input, in-circuit check     Class A, B
Repayer wallet hidden                       ✓          ZK private input + relay routing       Class A, B
Oracle price (liquidation data)             ✓          Encrypt FHE ciphertext oracle          Class A, B
Health factor (during liq computation)      ✓          Encrypt FHE homomorphic computation    Class A, B
Individual loan balances                    ✓          Encrypt FHE encrypted storage          Class A, B, D, F
Aggregate outstanding debt                  disclosed  Threshold decrypt — only total shown   Class A, B (not D, F)
Liquidation trust                           ✓          IKA FutureSign — consent pre-signed    Class A, B, C
Single operator key risk                    ✓          IKA 2PC-MPC — no single key            Class C
FHE liquidation handle replay               ✓          Handle pinning — PDA binding           Class A, B
Stale liquidation on healthy position       ✓          Breach confirmation epochs = 2         Class A, B
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

ACCEPTED DISCLOSURES (visible on-chain, by design):
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Borrow amount                               public     ZK public input — required for LTV     —
That a borrow occurred (LoanAccount PDA)    public     PDA creation visible                   —
Loan count (active loans)                   public     PDA count enumerable                   —
Denomination class withdrawn                public     ZK public output — required for SOL    —
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

EXPLICITLY OUT OF SCOPE (user responsibility):
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
IP address privacy                          not enforced   User must use Tor/VPN if needed    —
Post-exit fund movement                     not enforced   Stealth → known wallet link        —
OFAC compliance proofs                      roadmap    Railgun Proof of Innocence pattern     —
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

---

## 3. Attack Scenarios and Defenses

### Scenario 1: Timing Correlation Attack
**Attack**: Observer watches TX1 (user funds relay) and TX2 (relay deposits batch). If only one user deposits in an epoch, TX1 and TX2 have a 1:1 relationship — the commitment is trivially linked to the user.

**Defense**:
1. `min_real_deposits_before_flush = 8` — epoch doesn't close until 8 real deposits exist
2. VRF dummies added at flush time — even if few real deposits exist, dummy commitments expand the batch visually
3. PER Intel TDX — even with 1 real deposit, the enclave prevents linking

**Residual risk**: An adversary with full network visibility (ISP-level) sees TX1 arrive from a specific IP and TX2 follow shortly after. This is mitigated by: (a) the PER batching delay, (b) IKA relay acts as a mixing point for many users. Not mitigated by the protocol alone — IP privacy requires Tor/VPN.

---

### Scenario 2: Ring Membership Reduction Attack
**Attack**: Observer tracks which commitments have been nullified. Over time, the set of un-nullified commitments shrinks. For K=16 rings, as pool usage grows, the 16 ring candidates may include some already-nullified commitments — in theory, an observer could narrow the ring.

**Defense**: 
1. VRF dummy commitments are permanent and never nullified — they perpetually expand the ring candidate pool
2. Circuit validates that ring members have not been nullified (ring includes active and unspent commitments only — but observer doesn't know this inside the proof)
3. Historical root retention means users can submit proofs against older roots where the ring composition was different

**Residual risk**: Low. The VRF dummy pool grows monotonically and is always valid ring candidates.

---

### Scenario 3: Oracle Manipulation for Liquidation
**Attack**: An adversary with oracle price submission access submits a manipulated price to trigger an erroneous health factor breach on a healthy position.

**Defense**:
1. Encrypt FHE: price submitted as a ciphertext — adversary cannot verify the health factor before block inclusion
2. `consecutive_breach_count >= 2`: health factor must be in breach for 2 consecutive oracle epochs before FutureSign activates
3. `max_oracle_deviation_bps = 2000` (20%): if oracle price moves >20% between updates, liquidations pause for one epoch
4. IKA FutureSign requires the condition to be met on-chain — a single manipulated update is rejected

---

### Scenario 4: FHE Liquidation Replay Attack
**Attack**: After a successful liquidation reveal (Step 2), an adversary captures the decryption proof and attempts to use it against a different loan account.

**Defense**:
1. Handle pinning — the decryption proof is signed over the specific PDA address of the loan account
2. PDA address is derived from `seeds = [b"loan", nullifier_hash]` — unique per loan
3. Decryption proof for LoanAccount A's handle cannot be verified against LoanAccount B's PDA

---

### Scenario 5: Stealth Address Sweep Deanonymization
**Attack**: Recipient sweeps funds from a stealth address to a known wallet. An observer records: "stealth_address_X sent to known_wallet_Y at time T." This creates a permanent on-chain link.

**Defense**: Not enforceable by the protocol. This is user responsibility.

**Mitigation**: Users should either (a) use the stealth address as a long-term holding address without sweeping, (b) sweep only into another mixer or privacy tool, or (c) re-deposit into ShieldLend from the stealth address for continued privacy.

**Documentation**: Frontend includes a clear warning about stealth address sweep behavior.

---

### Scenario 6: MagicBlock PER Liveness Failure
**Attack**: MagicBlock PER goes offline. Users cannot exit the protocol (no withdrawals or disbursements process).

**Defense**: Three-tier protocol mode (see `docs/NOTE_LIFECYCLE.md`):
- After `per_fallback_epoch_threshold = 5` epochs without PER flush, Degraded mode activates automatically
- In Degraded mode, `shielded_pool::direct_withdraw(proof)` is enabled — users can exit with ZK ring anonymity but without temporal unlinking
- Frontend prominently displays the current protocol mode

---

## 4. Trust Assumptions Summary

| Component | Trust model | Threshold | Consequence if fully compromised |
|---|---|---|---|
| MagicBlock PER Intel TDX | Hardware attestation | N/A (hardware) | Deposit→commitment mapping exposed |
| IKA MPC network | Threshold cryptography | 2/3 | Unauthorized relay signing possible |
| Encrypt FHE oracle network | Threshold cryptography | 2/3 | Oracle price feeds decryptable; individual loan balances exposable |
| Umbra SDK key derivation | ECDH on Ed25519 | N/A (math) | Stealth address ownership linked |
| groth16-solana verifier | BN254 discrete log | N/A (math) | ZK proofs forgeable |
| Poseidon hash function | Collision resistance on BN254 | N/A (math) | Commitment collision, nullifier forgery |
| MagicBlock VRF | VRF output unpredictability | N/A (cryptography) | Dummy insertion predictable; anonymity set reduced |
| Circom + snarkjs | Trusted setup (Groth16) | N/A (ceremony) | Fake proofs generatable by toxic waste holder |

---

## 5. Disclosure: Accepted Residual Risks

The following risks are accepted and documented as the honest engineering tradeoff:

1. **Borrow amount is public** — required for on-chain LTV verification. From borrow amount + LTV ratio, collateral denomination is inferable.

2. **Loan count is public** — LoanAccount PDA creation is visible. Observers can count active loans.

3. **IP addresses visible to IKA relay** — the relay operator sees the IP address of whoever submitted the proof. Users who need IP privacy must use Tor or VPN at the application layer.

4. **Trusted setup for Groth16 circuits** — the three circuits (withdraw_ring, collateral_ring, repay_ring) each require a per-circuit trusted setup. Compromising the toxic waste from the ceremony allows generating valid fake proofs. Mitigation: multi-party computation ceremony (Powers of Tau) before production.

5. **Pre-alpha dependencies** — IKA dWallet and Encrypt FHE are pre-alpha. Hackathon uses mock signer / plaintext fallback. Production requires mainnet availability of both.

6. **Stealth address sweep** — forwarding from a stealth address to a known wallet permanently links them. The protocol cannot prevent users from doing this.
