# ShieldLend — Technical Architecture

---

## Program Overview

ShieldLend is three Anchor programs that communicate exclusively via CPI (Cross-Program Invocation). No program holds a private key. No program trusts a specific caller address — authorization flows through ZK proofs and PDA ownership.

```
┌─────────────────────────────────────────────────┐
│  shielded_pool                                  │
│  - holds ALL SOL                                │
│  - Poseidon Merkle tree (depth 24, ~16M leaves) │
│  - commitment insertion + epoch flush           │
│  - Groth16 withdrawal verification              │
│  - MagicBlock PER deposit + exit accounts       │
└──────────────────┬──────────────────────────────┘
                   │ CPI
┌──────────────────▼──────────────────────────────┐
│  lending_pool                                   │
│  - accounting only — zero SOL custody           │
│  - Kamino klend fork (poly-linear interest)     │
│  - Groth16 collateral + repay verification      │
│  - IKA dWallet CPI for disbursement co-signing  │
└──────────────────┬──────────────────────────────┘
                   │ CPI
┌──────────────────▼──────────────────────────────┐
│  nullifier_registry                             │
│  - PDA per nullifier_hash                       │
│  - shared: shielded_pool and lending_pool both  │
│    can mark nullifiers spent or locked          │
│  - only registered programs can write           │
└─────────────────────────────────────────────────┘
```

---

## shielded_pool

### Account Model

```
ShieldedPoolState (singleton PDA)
  - current_root: [u8; 32]
  - historical_roots: [[u8; 32]; 30]   // ring buffer — last 30 roots retained
  - root_index: u8                      // head pointer for ring buffer
  - next_index: u64
  - epoch_commitments: Vec<[u8; 32]>   // pending queue
  - epoch_start_slot: u64
  - epochs_without_per_flush: u8       // liveness tracking for fallback mode
  - protocol_mode: ProtocolMode        // FullPrivacy | Degraded | Emergency

CommitmentAccount (PDA per commitment_index)
  - commitment: [u8; 32]
  - inserted_at: u64

DepositQueueAccount (ephemeral, delegated to PER)
  - user_commitment: [u8; 32]
  - denomination_lamports: u64
  - relay_nonce: u64

ExitQueueAccount (ephemeral, delegated to PER)
  - stealth_address: Pubkey
  - amount_lamports: u64
  - relay_nonce: u64
```

### Instructions

| Instruction | Signer | Purpose |
|---|---|---|
| `deposit` | IKA relay (via PER) | Add commitment to epoch queue |
| `flush_epoch` | IKA relay | VRF-shuffle queue + insert dummies + update Merkle root |
| `withdraw` | IKA relay (proof-gated) | Verify Groth16 ring proof, mark nullifier, queue SOL to PER exit batch |
| `disburse` | lending_pool (CPI) | Queue loan disbursement amount to PER exit batch |
| `flush_exits` | IKA relay (via PER) | Flush exit queue — send each amount to its Umbra stealth address |

### Merkle Tree

- Depth: 24 (supports 16,777,216 leaves)
- Hash: Poseidon2 (matches circom circuits — BN254 field arithmetic)
- Zero values: precomputed per level for sparse tree initialization
- Root update: after every `flush_epoch` — all pending commitments inserted atomically

### VRF Dummy Insertion (flush_epoch)

```rust
// Pseudocode — actual implementation uses MagicBlock VRF callback
fn flush_epoch(ctx, vrf_proof) {
    let shuffled = fisher_yates_shuffle(epoch_commitments, vrf_proof.randomness);
    let n_dummies = vrf_proof.randomness % MAX_DUMMIES;
    for i in 0..n_dummies {
        shuffled.insert(vrf_random_position(i), dummy_commitment(i));
    }
    for c in shuffled {
        merkle_insert(c);
    }
    update_root();
}
```

VRF proof is included in the `flush_epoch` transaction. On-chain verification confirms the randomness was not manipulated. Dummy commitments are Poseidon hashes of known zero values — publicly known but indistinguishable from real commitments in a ring proof. Once inserted, they remain in the tree permanently and appear as ring candidates for all future withdrawal and borrow proofs.

### Withdrawal Flow

```
Client:
  1. Load note (secret, nullifier) from AES-256-GCM vault
  2. Fetch current Merkle root + ring of 16 commitments (includes own + VRF dummies)
  3. snarkjs.groth16.fullProve(withdraw_ring, inputs) → proof + publicSignals
  4. Send proof + stealth_meta_address to IKA relay (off-chain)
     [relay wallet will be the on-chain signer — user wallet not published]

IKA relay submits on-chain (shielded_pool::withdraw):
  5. groth16_solana::verify(proof, publicSignals, VK_HASH)
  6. Check nullifier_registry::is_spent(nullifierHash) == false
  7. CPI → nullifier_registry::mark_spent(nullifierHash)
  8. Generate fresh Umbra stealth address from stealth_meta_address
  9. Enqueue ExitQueueAccount { stealth_address, denomination_lamports } in PER

PER exit flush (flush_exits):
  10. Transfer denomination_lamports → stealth_address for each exit in queue
      [withdrawal exits and borrow disbursement exits flush together — indistinguishable]
```

`onAccountChange()` on `ShieldedPoolState.merkle_root` signals deposit confirmation to the frontend when the root updates after `flush_epoch`.

---

## lending_pool

### Account Model

```
LoanAccount (PDA: seeds = [b"loan", collateral_nullifier_hash])
  - collateral_nullifier_hash: [u8; 32]
  - collateral_denomination_class: u8     // index into DENOMINATION_TABLE
  - loan_id: u64
  - disbursed_at_slot: u64
  - borrow_amount: u64                    // public — visible on-chain (ZK public input)
  - status: LoanStatus { Active, Repaid, Liquidated }

  // FHE liquidation — handle pinning [inspired by Laolex/shieldlend C-01, Anchor PDA adaptation]
  - is_liquidatable: EncryptedBool        // Encrypt FHE ciphertext
  - liq_ciphertext_handle: [u8; 32]       // handle snapshot at liquidation request time
  - pending_liquidation_reveal: bool
  - confirmed_liquidatable: bool

  // Breach confirmation [prevents single-epoch oracle manipulation]
  - consecutive_breach_count: u8
  - breach_first_slot: u64
  - future_sign_authorized: bool

  // Interest tracking
  - last_accrual_slot: u64
  - interest_rate_bps: u64

InterestRateModel (singleton PDA)
  - utilization_kinks: [u16; 11]          // basis points — 11-point Kamino model
  - rate_at_kink: [u16; 11]              // annual rate at each kink
  - last_updated: i64
```

### Instructions

| Instruction | Signer | Purpose |
|---|---|---|
| `borrow` | IKA relay (proof-gated) | Verify collateral proof, create LoanAccount, CPI → IKA disburse to stealth address |
| `repay` | IKA relay (proof-gated) | Verify repay_ring proof, clear LoanAccount, unlock nullifier |
| `liquidate` | IKA FutureSign trigger | Execute pre-authorized liquidation when health_factor breached |
| `update_rate` | Governance | Update interest rate kink table |

### Borrow Flow

```
Client:
  1. Select collateral note (secret, nullifier, denomination)
  2. Choose borrow amount (must satisfy: denomination × LTV_BPS ≥ borrowed × 10000)
  3. snarkjs.groth16.fullProve(collateral_ring, inputs) → proof
     [borrowed and minRatioBps are ZK public outputs — visible on-chain]
  4. Generate fresh Umbra stealth address for loan disbursement
  5. Send proof + stealth_address to IKA relay (off-chain)
     [relay wallet will be the on-chain signer — borrower wallet not published]

IKA relay submits on-chain (lending_pool::borrow):
  6. groth16_solana::verify(proof, publicSignals, COLLATERAL_VK_HASH)
  7. Verify nullifier not spent (collateral locked, not consumed)
  8. CPI → nullifier_registry::lock_nullifier(nullifierHash)
  9. Create LoanAccount
  10. CPI → IKA::approve_message(disbursement_params)
        → IKA MPC network validates + co-signs
        [both on-chain LTV verification AND IKA approval required]
  11. CPI → shielded_pool::disburse(loan_amount, stealth_address)
        → queued as ExitQueueAccount in PER alongside withdrawal exits

IKA FutureSign stored at borrow time:
  "Liquidate loanId X if health_factor < Y"
  Borrower pre-authorizes. Condition checked on-chain at liquidation time.
  Neither borrower nor operator can execute unilaterally.
```

### Repay Flow

```
Client:
  1. Load collateral note to regenerate nullifier
  2. Query on-chain: outstanding_balance = borrow_amount × compound(rate_history, elapsed)
     [Kamino rate history is public on-chain — program computes this at repay time]
  3. Generate Groth16 repay_ring proof:
     PRIVATE: nullifier, repaymentAmount
     PUBLIC:  nullifierHash, loanId, outstanding_balance
     CIRCUIT: repaymentAmount ≥ outstanding_balance  [verified in-circuit; repaymentAmount never on-chain]
  4. Send repaymentAmount SOL + proof to IKA relay
     [relay routes repayment SOL — traffic indistinguishable from deposits]

IKA relay submits on-chain (lending_pool::repay):
  5. groth16_solana::verify(proof, publicSignals, REPAY_VK_HASH)
     [circuit already proved repaymentAmount ≥ outstanding_balance in step 3]
  6. CPI → nullifier_registry::unlock_nullifier(nullifierHash)
  7. Close LoanAccount
```

### Interest Rate Model (Kamino klend fork)

Poly-linear model with 11 kink points. Rate curve:

```
rate
  |                               ___________
  |                          ____/
  |                     ____/
  |              _______/
  |_____________/
  +-------------------------------------------
  0%     20%    40%    60%    80%   90%  100%
                     utilization
```

At each kink: `rate = lerp(rate[i], rate[i+1], (utilization - kink[i]) / (kink[i+1] - kink[i]))`

The outstanding balance at repay time is computed from the public rate history stored in `InterestRateModel` — no encrypted state needed for the sufficiency check.

---

## nullifier_registry

### Account Model

```
NullifierAccount (PDA: seeds = [b"nullifier", nullifier_hash])
  - nullifier_hash: [u8; 32]          // Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)
  - status: NullifierStatus { Active, Locked, Spent }
  - leaf_index: u64                   // position in Merkle tree — recorded at registration
  - registered_at_slot: u64

RegistryConfig (singleton PDA)
  - authorized_programs: [Pubkey; 8]  // shielded_pool + lending_pool
```

### Status Transitions

```
(none) → Active   : nullifier_registry::register(nullifier_hash)
Active → Locked   : lending_pool::borrow() — collateral nullifier locked
Locked → Active   : lending_pool::repay() — collateral released after repayment
Locked → Spent    : lending_pool::liquidate() — collateral consumed
Active → Spent    : shielded_pool::withdraw() — note consumed
```

A Locked nullifier cannot be withdrawn — prevents collateral theft during an active loan.
A Spent nullifier cannot be reused — prevents double-spend.

---

## ZK Circuits

### withdraw_ring.circom

```
Private inputs:
  secret, nullifier, denomination
  leaf_index                          // position of commitment in Merkle tree [V-1 fix]
  pathElements[24], pathIndices[24]   // Merkle inclusion proof
  ring[16]                            // ring of K=16 commitments
  own_index                           // which ring element is yours

Public outputs:
  ring[16]                            // revealed ring (for nullifier checking)
  nullifierHash                       // Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)
  root                                // Merkle root matched (must be in historical_roots[30])
  denomination_out                    // denomination being withdrawn

Constraints:
  commitment = Poseidon(secret, nullifier, denomination)
  ring[own_index] == commitment
  MerkleInclude(commitment, pathElements, pathIndices, leaf_index) == root
  nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)

Notes:
  - leaf_index added as private input [inspired by Penumbra position-dependent nullifiers]
  - SHIELDED_POOL_PROGRAM_ID as domain separator [inspired by Aztec app-siloed nullifiers]
  - root validated against historical_roots ring buffer (not just current_root)
```

### collateral_ring.circom

```
Private inputs:
  secret, nullifier, denomination
  leaf_index                          // position of commitment in Merkle tree [V-1 fix]
  pathElements[24], pathIndices[24]
  ring[16], own_index
  borrowed                            // loan amount
  minRatioBps                         // LTV floor in basis points

Public outputs:
  ring[16], nullifierHash, root
  borrowed, minRatioBps               // for on-chain LTV verification
  NOTE: denomination is inferable from borrowed/minRatioBps — accepted tradeoff [V-2]

Constraints:
  commitment = Poseidon(secret, nullifier, denomination)
  ring[own_index] == commitment
  MerkleInclude(commitment, pathElements, pathIndices, leaf_index) == root
  nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)
  denomination * minRatioBps >= borrowed * 10000   // LTV check in-circuit
```

### repay_ring.circom

```
Private inputs:
  nullifier                           // proves knowledge of collateral secret
  leaf_index                          // position of collateral commitment [V-1 fix]
  repaymentAmount                     // never published on-chain

Public outputs:
  nullifierHash                       // Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)
  loanId                              // identifies which loan PDA to clear
  outstanding_balance                 // computed on-chain from Kamino rate history

Constraints:
  nullifierHash = Poseidon(nullifier, leaf_index, SHIELDED_POOL_PROGRAM_ID)
  repaymentAmount >= outstanding_balance   // sufficiency check in-circuit
```

### Circuit Parameter: SHIELDED_POOL_PROGRAM_ID

All three circuits include `SHIELDED_POOL_PROGRAM_ID` as a compile-time constant in the nullifierHash computation. This serves as a domain separator that:
1. Prevents cross-contract nullifier correlation (if ShieldLend ever adds a V2 program or complementary protocol, notes cannot be linked across them)
2. Binds proof validity to this specific program — a proof generated for ShieldLend cannot be replayed in a different protocol

*Architecture inspiration: Aztec's app-siloed nullifier key derivation (`nullifier_app = Poseidon(nsk_master, app_contract_address)`)*

---

## MagicBlock PER — Deposit and Exit Batching

```
MagicBlock PER (Private Ephemeral Rollup)
  Delegates: shielded_pool deposit queue accounts + exit queue accounts
  Intel TDX enclave: deposit→commitment mapping hidden inside enclave
  Settlement: fraud-provable state commit to base Solana
  Privacy: REQUIRED

  Deposit path: user TX1 → PER enclave → batched TX2 → Merkle insertion
  Exit path:    withdrawal + disbursement exits queued together
                → single flush_exits → SOL to respective Umbra stealth addresses
                → exit type (withdrawal vs borrow) is indistinguishable in the batch
```

The PER handles both sides of the privacy-critical path: deposit inputs and SOL outputs. A single ephemeral environment covers both, so the same enclave isolation and batch-privacy properties apply to all fund flows.

---

## IKA dWallet CPI Pattern

```rust
// Every disbursement requires both program validation AND IKA co-sign
lending_pool::borrow {
    // Program-side validation (on-chain)
    verify_groth16(proof, collateral_vk_hash)?;
    verify_ltv(denomination_class, borrowed)?;

    // IKA co-sign request (CPI → IKA program)
    ika_dwallet::approve_message(
        ctx.accounts.dwallet,
        DisbursementMessage { recipient: stealth_address, amount: borrowed, loan_id },
    )?;

    // SOL release (only reachable after both validations)
    shielded_pool::disburse(borrowed, stealth_address)?;
}
```

---

## Encrypt FHE — Oracle, Solvency, and Liquidation Pattern

```rust
// Oracle price submitted as FHE ciphertext — MEV bots cannot compute
// health_factor from an encrypted price feed in the mempool
#[encrypt_fn]
fn compute_health_factor(
    collateral_value: EncryptCiphertext,  // price feed × denomination — encrypted
    outstanding: EncryptCiphertext,       // total owed — encrypted
) -> EncryptCiphertext {
    collateral_value / outstanding        // homomorphic division — no plaintext
}

// Aggregate solvency: homomorphic sum over all loan balances
// reveals only total outstanding, not individual positions
// Inspired by Penumbra's homomorphic ElGamal flow encryption for validator-aggregated sums
#[encrypt_fn]
fn aggregate_outstanding(
    balances: &[EncryptCiphertext],
) -> EncryptCiphertext {
    balances.iter().fold(EncryptCiphertext::zero(), |acc, b| acc + b)
}

// Interest accrual — called by keeper bot (not triggered inside FHE context)
// Inspired by Laolex/shieldlend keeper pattern: accruing inside FHE would leak
// encrypted debt aggregates during utilization computation
fn accrue_interest(loan: &mut LoanAccount, current_slot: u64, rate_bps: u64) {
    // Slots since last accrual (public computation — rate history is public)
    let slots_elapsed = current_slot - loan.last_accrual_slot;
    let rate_per_slot = rate_bps / (365 * 24 * 9000);  // ~9000 slots/hr

    // FHE multiplication: interest = total_debt * rate_per_slot * slots_elapsed
    loan.total_debt_encrypted = encrypt_mul(
        &loan.total_debt_encrypted,
        &encrypt_u64(1 + rate_per_slot * slots_elapsed)
    );
    loan.last_accrual_slot = current_slot;
}
```

### Three-Step Async Liquidation (FHE-Compatible)

*Pattern adapted from Laolex/shieldlend EVM implementation, mapped to Anchor PDA model.*

FHE decryption is asynchronous — health factor ciphertexts must be sent to Encrypt threshold network and decrypted before liquidation can proceed. This requires a three-step flow to prevent liquidating solvent positions.

```
Step 1: request_liquidation_reveal (permissionless)
  - Snapshot liq_ciphertext_handle = loan.is_liquidatable.handle()
  - Set pending_liquidation_reveal = true
  - Emit event → Encrypt oracle initiates threshold decryption

Step 2: verify_liquidation_reveal (called by Encrypt oracle keeper)
  - Verify Encrypt re-encryption proof is signed over loan's PDA address [C-01 binding]
  - Verify submitted handle matches liq_ciphertext_handle (snapshot from Step 1)
  - Set confirmed_liquidatable = decrypted_value
  - Set pending_liquidation_reveal = false

Step 3: liquidate (permissionless, only if confirmed)
  - Require confirmed_liquidatable == true
  - Require consecutive_breach_count >= breach_confirmation_epochs
  - Execute IKA FutureSign → consume collateral
```

**Handle Pinning Security Property [C-01]**:
The PDA seed constraint `seeds = [b"loan", collateral_nullifier_hash]` cryptographically derives a unique address for each loan. The Encrypt oracle proof is signed over this PDA address. A decryption proof from Loan A cannot be submitted against Loan B's account — the PDA address mismatch causes verification failure.

*Architecture inspiration: Laolex/shieldlend's handle pinning pattern. Solidity equivalent: `require(handlesList[0] == FHE.toBytes32(positions[borrower].isLiquidatable))`. Anchor equivalent: PDA seed uniqueness as structural binding.*

Threshold decryption (2/3 Encrypt network) used for:
1. **Liquidation confirmation**: `is_liquidatable` → three-step reveal → boolean result
2. **Aggregate solvency**: `Σ(outstanding[i])` → single decrypt → total outstanding, no individual exposure
3. **Targeted audit**: single `loanId` balance decrypted for compliance disclosure
