# ShieldLend — Note Lifecycle, Protocol Parameters, and Operational Modes

*This document defines the complete note state machine, all configurable protocol parameters, and the three operational modes with their privacy/liveness tradeoffs.*

---

## 1. Note State Machine

A "note" is a commitment in the Merkle tree, representing a fixed-denomination SOL deposit. Every note has an associated entry in `NullifierRegistry` that tracks its lifecycle state.

```
                          ┌──────────────────────────────────────────────┐
                          │                   LEGEND                      │
                          │  → : state transition                         │
                          │  [instruction]: what triggers the transition  │
                          │  ✗ : transition blocked / rejected            │
                          └──────────────────────────────────────────────┘

   UNREGISTERED
        │
        │ [shielded_pool::deposit + flush_epoch]
        │ Commitment inserted into Merkle tree via PER batch.
        │ NullifierAccount PDA created: status = Active
        ▼
      ACTIVE ──────────────────────────────────────────────────────────────┐
        │                                                                  │
        │ [shielded_pool::withdraw]                                        │
        │ Ring proof valid. nullifierHash matches. Status not Locked/Spent.│
        ▼                                                                  │
      SPENT (terminal)                                                     │
        │                                                                  │ [lending_pool::borrow]
        │ Cannot withdraw again (double-spend).                            │ Collateral ring proof valid.
        │ Cannot borrow against (already consumed).                        │ Status = Active (not already locked).
        ▼                                                                  │
      [end — note is gone]                                                 ▼
                                                                        LOCKED
                                                                           │
                                               ┌───────────────────────────┤
                                               │                           │
                              [lending_pool::repay]          [lending_pool::liquidate]
                              Repay ring proof valid.        IKA FutureSign executes.
                              Private payment receipt         Health factor confirmed breached
                              verifies settlement ≥ owed.
                              Status → Active.               (consecutive_breach_count ≥ 2).
                              LoanAccount PDA closed.        LoanAccount PDA closed.
                              confirmed_liquidatable = false. Status → Spent.
                                               │                           │
                                               ▼                           ▼
                                            ACTIVE                       SPENT (terminal)
                                               │                           │
                                               │                           │ Cannot be withdrawn.
                                               │                           │ Cannot be borrowed against.
                                          (re-enters                       ▼
                                          withdrawal flow              [end — collateral consumed]
                                          or borrow flow)
```

### Blocked Transitions (Rejected On-Chain)

| From state | Attempted instruction | Result |
|---|---|---|
| ACTIVE | `withdraw` with invalid ring proof | Rejected — groth16-solana returns error |
| ACTIVE | `withdraw` with nullifier already Spent | Rejected — NullifierAccount.status check fails |
| LOCKED | `withdraw` | Rejected — cannot withdraw collateral while loan active |
| LOCKED | `borrow` (attempt to lock again) | Rejected — status must be Active to lock |
| SPENT | `withdraw` | Rejected — double-spend, NullifierAccount.status = Spent |
| SPENT | `borrow` | Rejected — note is consumed |
| Any | Proof with unrecognized Merkle root | Rejected — root not in historical_roots ring buffer |
| Any | Proof with expired root (> 30 epochs old) | Rejected — root evicted from ring buffer |

---

## 2. LoanAccount Lifecycle

```
   LoanAccount PDA: seeds = [b"loan", nullifier_hash]
   Created by: lending_pool::borrow
   Closed by:  lending_pool::repay OR lending_pool::liquidate

   States:
     Active     — loan disbursed, interest accruing
     Repaid     — loan fully repaid, PDA closed
     Liquidated — health factor breached, collateral consumed, PDA closed
```

### LoanAccount Fields (Complete)

```rust
pub struct LoanAccount {
    // Core loan data
    pub collateral_nullifier_hash: [u8; 32],   // ties loan to collateral note
    pub collateral_denomination_class: u8,      // index into DENOMINATION_TABLE
    pub loan_id: u64,
    pub disbursed_at_slot: u64,
    pub borrow_amount: u64,                     // public — ZK public input
    pub borrow_bucket: u16,                     // optional bucket for amount-fingerprinting reduction
    pub status: LoanStatus,                     // Active, Repaid, Liquidated

    // FHE liquidation — handle pinning [C-01, adapted from Laolex/shieldlend]
    pub is_liquidatable: EncryptedBool,         // FHE ciphertext — health factor result
    pub liq_ciphertext_handle: [u8; 32],        // hash of is_liquidatable ciphertext at request time
    pub pending_liquidation_reveal: bool,       // Step 1 → Step 2 in progress
    pub confirmed_liquidatable: bool,           // Step 2 completed; liquidation authorized

    // Breach confirmation [V-5 fix — prevents single-epoch oracle manipulation]
    pub consecutive_breach_count: u8,           // consecutive oracle epochs in breach
    pub breach_first_slot: u64,                 // slot of first breach detection
    pub future_sign_authorized: bool,           // FutureSign armed after breach threshold met

    // Interest tracking
    pub last_accrual_slot: u64,                 // last slot interest was accrued
    pub interest_rate_bps: u64,                 // current rate in basis points

    // Private repayment settlement
    pub latest_repayment_receipt_hash: [u8; 32],
    pub repayment_vault: Pubkey,

    // PDA management
    pub bump: u8,
}
```

### Three-Step Liquidation Flow

*Adapted from Laolex/shieldlend's EVM pattern, mapped to Anchor PDA model.*

**Step 1 — Request Liquidation Reveal** (permissionless — anyone can call)
```
Preconditions:
  - LoanAccount.status == Active
  - LoanAccount.pending_liquidation_reveal == false
  - LoanAccount.consecutive_breach_count >= breach_confirmation_epochs (default: 2)

Actions:
  - Set pending_liquidation_reveal = true
  - Snapshot liq_ciphertext_handle = is_liquidatable.handle()
  - Emit LiquidationRevealRequested { nullifier_hash, handle }
  → Encrypt FHE oracle picks up the event and initiates threshold decryption
```

**Step 2 — Verify Liquidation Reveal** (called by Encrypt oracle keeper after decryption)
```
Preconditions:
  - pending_liquidation_reveal == true
  - kernel_proof is signed over this LoanAccount's PDA address [C-01 binding]
  - liq_ciphertext_handle matches the submitted handle

Actions:
  - Verify Encrypt FHE re-encryption proof against PDA address + handle
  - Set confirmed_liquidatable = decrypted_value
  - Set pending_liquidation_reveal = false
  - Emit LiquidationConfirmed { nullifier_hash, is_liquidatable }
```

**Step 3 — Execute Liquidation** (permissionless — anyone can call if confirmed)
```
Preconditions:
  - confirmed_liquidatable == true
  - IKA FutureSign condition met (health_factor < threshold, consecutive epochs)

Actions:
  - CPI → IKA FutureSign execution
  - CPI → nullifier_registry::mark_spent(collateral_nullifier_hash)
  - Close LoanAccount PDA
  - Transfer collateral (denomination_lamports - liquidation_fee) to caller
  - Transfer liquidation_fee to protocol reserve
```

**MVP liquidation policy**: Full liquidation only. Partial liquidation is intentionally deferred to reduce bad-debt, rounding, stale-oracle, and repeated-liquidation accounting risk. The MVP also uses minimum borrow size, conservative LTV, reserve accounting, and stale-oracle pause checks.

**Stale Flag Clearing (on any position improvement)**

*Adapted from Laolex/shieldlend [CR-2] — prevents stale confirmation from liquidating a now-healthy position.*

```
On lending_pool::repay():
  - Set confirmed_liquidatable = false
  - Set pending_liquidation_reveal = false
  - Set consecutive_breach_count = 0
  - Recompute is_liquidatable via Encrypt FHE with fresh oracle price

On lending_pool::add_collateral():  [future instruction]
  - Same stale flag clearing as repay
```

---

## 3. Protocol Parameters

### Anonymity Parameters

| Parameter | Default | Governance? | Rationale |
|---|---|---|---|
| `ring_size_k` | 16 | Yes (governance vote) | K=16 guarantees 1-in-16 anonymity minimum |
| `min_real_deposits_before_flush` | 8 | Yes | Guarantees ≥50% real ring members; prevents VRF collapse |
| `historical_root_buffer_size` | 30 | No (fixed) | 30 epochs × ~5min = ~2.5 hours of offline tolerance |
| `vrf_max_dummies_per_epoch` | 4 | Yes | Max dummy insertions per flush; controls tree growth rate |
| `progressive_ring_k_thresholds` | [50: K=8, 200: K=16, 1000: K=32] | Yes | Ring size scales with pool depth |

### Temporal Parameters

| Parameter | Default | Governance? | Rationale |
|---|---|---|---|
| `epoch_length_slots` | 512 | Yes | ~3.4 minutes at 400ms/slot; batching window |
| `min_epoch_duration_slots` | 256 | Yes | Minimum wait before flush even if deposit count met |
| `exit_batch_min_size` | 4 | Yes | Minimum exits before PER flush; temporal unlinking quality |
| `per_fallback_epoch_threshold` | 5 | Yes | Epochs without PER flush before Degraded mode activates |

### Lending Parameters

| Parameter | Default | Governance? | Rationale |
|---|---|---|---|
| `denominations_lamports` | [100_000_000, 1_000_000_000, 10_000_000_000] | No (fixed) | 0.1 SOL, 1 SOL, 10 SOL; fixed by circuit design |
| `min_collateral_ratio_bps` | 15000 | Yes | 150% overcollateralization |
| `liquidation_fee_bps` | 500 | Yes | 5% liquidation bonus to liquidator |
| `protocol_reserve_bps` | 200 | Yes | 2% to protocol reserve |
| `min_borrow_increment_lamports` | 10_000_000 | Yes | 0.01 SOL minimum; reduces denomination inference precision |
| `supported_borrow_buckets_lamports` | governance-defined | Yes | Optional buckets reduce amount fingerprinting while preserving deterministic accounting |
| `minimum_borrow_lamports` | governance-defined | Yes | Avoids dust positions and uneconomic liquidations |

### Oracle / Liquidation Parameters

| Parameter | Default | Governance? | Rationale |
|---|---|---|---|
| `breach_confirmation_epochs` | 2 | Yes | Consecutive oracle epochs in breach before FutureSign arms |
| `max_oracle_deviation_bps` | 2000 | Yes | 20% max price move between oracle updates; circuit breaker |
| `oracle_staleness_epochs` | 3 | Yes | Oracle must update within 3 epochs or liquidations pause |
| `keeper_min_accrual_slots` | 216_000 | Yes | ~1 day between interest accruals (216k slots × 400ms) |

### ZK Circuit Parameters

| Parameter | Value | Changeable? | Rationale |
|---|---|---|---|
| `merkle_tree_depth` | 24 | No (circuit constraint) | Supports 16,777,216 leaves |
| `proof_system` | Groth16 | No (syscall dependency) | groth16-solana uses BN254 native syscalls |
| `nullifier_domain` | SHIELDED_POOL_PROGRAM_ID | No (circuit constraint) | App-siloed — prevents cross-contract correlation |
| `commitment_formula` | Poseidon(secret, nullifier, denomination) | No | Circuit constraint |
| `nullifier_formula` | Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID) | No | Circuit constraint |

---

## 4. Operational Modes

### Mode 1: Full Privacy (Default)

**Activates when**: All protocol dependencies operational (MagicBlock PER, MagicBlock Private Payments, IKA dWallet, Encrypt FHE)

```
Deposit path:  User → IKA relay → MagicBlock PER enclave → ShieldedPool batch insert
Exit path:     ShieldedPool → IKA relay → MagicBlock PER exit batch → Umbra stealth address
Repay path:    MagicBlock Private Payments → receipt bound to loanId/nullifier/outstanding/vault
Oracle path:   Encrypt FHE ciphertexts → homomorphic health factor → threshold decryption for liquidation
Relay:         IKA 2PC-MPC dWallet
```

**Privacy level**: Maximum. All four layers active.

---

### Mode 2: Degraded Privacy (PER Offline)

**Activates when**: `ShieldedPoolState.epochs_without_per_flush >= per_fallback_epoch_threshold` or private payment settlement is unavailable

**Trigger mechanism**: Keeper or governance calls `shielded_pool::activate_degraded_mode()`. Frontend displays prominent banner.

```
Deposit path:  User → IKA relay → ShieldedPool direct insert (no batching)
Exit path:     ShieldedPool::direct_withdraw(ring_proof, stealth_address) → Umbra stealth
Repay path:    IKA relay transfer fallback; amount may be visible
Oracle path:   Unchanged (Encrypt FHE still active)
Relay:         IKA 2PC-MPC dWallet (unchanged)
```

**Privacy loss in Degraded mode**:
- Temporal unlinking is lost — deposit and exit transactions are no longer batched
- Timing correlation possible — "relay submitted deposit at T1, relay submitted withdrawal at T2" is observable
- ZK ring anonymity is preserved — which commitment was spent remains hidden (K=16)
- Exit destination is preserved — Umbra stealth addresses still used
- Relay wallet still hides user wallet — user never appears on-chain
- Repayment amount privacy is reduced if private payments are unavailable

**Frontend display**: "Protocol is in Degraded Privacy Mode. Temporal unlinking is reduced. ZK and stealth address privacy remain active."

---

### Mode 3: Emergency (Multiple Dependencies Offline)

**Activates when**: Both MagicBlock PER and IKA dWallet are unavailable for an extended period (governance vote required)

**Trigger mechanism**: Multi-sig governance vote; time-locked activation.

```
Exit path:  ShieldedPool::emergency_withdraw(ring_proof) → user's own wallet (no relay, no stealth)
            OR
            ShieldedPool::emergency_collateral_recover() → governance-assisted recovery
```

**Privacy loss in Emergency mode**:
- User wallet appears on-chain as the transaction signer (relay bypassed)
- No Umbra stealth address (direct SOL release to user wallet)
- ZK ring anonymity may still be preserved if user submits the ring proof directly

**This mode is a last resort.** It prioritizes fund recovery over privacy. Only activated if MagicBlock and IKA are both down for an extended period.

---

## 5. Epoch Lifecycle

```
                ┌─────────────────────────────────────────────────────┐
                │                   EPOCH LIFECYCLE                    │
                └─────────────────────────────────────────────────────┘

Epoch start
    │
    │ Users deposit via IKA relay → DepositQueueAccount entries accumulate
    │ (minimum min_real_deposits_before_flush = 8 real deposits required before flush)
    │
    │ [min_epoch_duration_slots elapsed AND deposit count >= threshold]
    │
    ▼
flush_epoch called (IKA relay, PER-authorized)
    │
    ├─ 1. MagicBlock VRF callback received (randomness for this epoch)
    ├─ 2. Fisher-Yates shuffle of deposit queue using VRF randomness
    ├─ 3. Generate dummy commitments inside PER/TEE:
    │      Poseidon("SHIELDLEND_DUMMY", pool_id, epoch_id, dummy_index,
    │               magicblock_vrf_output, enclave_private_entropy)
    │      [0..n_dummies, where n_dummies = vrf_randomness % vrf_max_dummies_per_epoch]
    ├─ 4. Insert shuffled real + dummy commitments into Merkle tree
    ├─ 5. Update current_root
    ├─ 6. Push old current_root into historical_roots ring buffer
    └─ 7. Increment root_index; clear epoch_commitments queue

Epoch committed to base Solana
    │
    └─ onAccountChange(ShieldedPoolState.merkle_root) fires → frontend confirms deposits

═══════════════════════════════════════════════════════════════════════

Exit flush (separate from deposit epoch, can happen any time)
    │
    │ [min exit batch size = 4 exits accumulated]
    │
    ▼
flush_exits called (IKA relay, PER-authorized)
    │
    └─ For each ExitQueueAccount:
         Transfer denomination_lamports → stealth_address (via system_program::transfer)
         [withdrawal exits and borrow disbursement exits in same batch — indistinguishable]
```

---

## 6. VRF Dummy Indistinguishability Requirement

This is a critical security property. VRF dummy commitments must be computationally indistinguishable from real commitments on-chain inspection.

**Real commitment formula**: `commitment = Poseidon(secret, nullifier, denomination)`
- `secret`: 256-bit random, generated client-side, never published
- `nullifier`: 256-bit random, generated client-side, never published
- `denomination`: one of {100_000_000, 1_000_000_000, 10_000_000_000}

**VRF dummy formula**:
`dummy_commitment = Poseidon("SHIELDLEND_DUMMY", pool_id, epoch_id, dummy_index, magicblock_vrf_output, enclave_private_entropy)`
- `magicblock_vrf_output`: verifiable epoch randomness
- `enclave_private_entropy`: generated inside PER/TEE, never published
- The dummy preimage is discarded after insertion

**Why this is indistinguishable**: An external observer sees only `dummy_commitment` — a 256-bit field element. Because the dummy preimage includes enclave-private entropy that is never published or stored, the observer cannot recompute the dummy set and cannot distinguish it from `Poseidon(secret, nullifier, denomination)` for unknown secret and nullifier.

**What the observer CAN compute**: Given the on-chain VRF proof, they can verify that epoch randomness was generated from the correct input. They cannot derive the PER private entropy or the discarded dummy preimage.

**Property**: VRF dummy commitments are computationally indistinguishable from real commitments to any adversary with polynomial computational resources, under the VRF's security assumptions.

---

## 7. User History and Disclosure Lifecycle

The protocol does not store a user-indexed activity feed. History is reconstructed from the user's encrypted local vault and public chain evidence.

### Local History Record

Each frontend operation appends an encrypted journal record:

```rust
HistoryRecord {
    operation: Deposit | Withdraw | Borrow | Repay | Liquidate,
    local_note_id: [u8; 32],
    loan_id: Option<u64>,
    tx_signature: String,
    merkle_root: Option<[u8; 32]>,
    nullifier_hash: Option<[u8; 32]>,
    proof_public_signals_hash: Option<[u8; 32]>,
    private_payment_receipt_hash: Option<[u8; 32]>,
    amount_display_bucket: Option<String>,
    created_at_slot: u64,
}
```

The journal is encrypted with the same wallet-derived key hierarchy as note storage. It is for user experience and compliance export only; it is not required for protocol solvency.

### Scoped Disclosure Packet

For compliance, a user can export selected records with:
- transaction signatures,
- proof public signals,
- Merkle root and nullifier status evidence,
- private payment receipt hash for repayments,
- optional auditor viewing key for only the selected records.

There is no protocol operator viewing key and no global deanonymization key. Disclosure is user-controlled and scoped to the records the user chooses to reveal.
