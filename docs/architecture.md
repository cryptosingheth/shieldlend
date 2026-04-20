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
│  - MagicBlock PER deposit accounts delegated    │
└──────────────────┬──────────────────────────────┘
                   │ CPI
┌──────────────────▼──────────────────────────────┐
│  lending_pool                                   │
│  - accounting only — zero SOL custody           │
│  - Kamino klend fork (poly-linear interest)     │
│  - Groth16 collateral + repay verification      │
│  - IKA dWallet CPI for disbursement co-signing  │
│  - Encrypt FHE ciphertext loan accounts         │
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
  - merkle_root: [u8; 32]
  - next_index: u64
  - epoch_commitments: Vec<[u8; 32]>   // pending queue
  - epoch_start_slot: u64

CommitmentAccount (PDA per commitment_index)
  - commitment: [u8; 32]
  - inserted_at: u64

DepositQueueAccount (ephemeral, delegated to PER)
  - user_commitment: [u8; 32]
  - denomination_lamports: u64
  - relay_nonce: u64
```

### Instructions

| Instruction | Signer | Purpose |
|---|---|---|
| `deposit` | IKA relay (via PER) | Add commitment to epoch queue |
| `flush_epoch` | IKA relay | VRF-shuffle queue + insert dummies + update Merkle root |
| `withdraw` | Any (proof-gated) | Verify Groth16 ring proof, mark nullifier, release SOL to Umbra stealth address |

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

VRF proof is included in the `flush_epoch` transaction. On-chain verification confirms the randomness was not manipulated. Dummy commitments are Poseidon hashes of known zero values — publicly known but indistinguishable from real commitments in a ring proof.

### Withdrawal Flow

```
Client:
  1. Load note (secret, nullifier) from AES-256-GCM vault
  2. Fetch current Merkle root + ring of 16 commitments (includes own)
  3. snarkjs.groth16.fullProve(withdraw_ring, inputs) → proof + publicSignals
  4. Submit withdraw instruction with proof + stealth_address

On-chain (shielded_pool::withdraw):
  5. groth16_solana::verify(proof, publicSignals, VK_HASH)
  6. Check nullifier_registry::is_spent(nullifierHash) == false
  7. CPI → nullifier_registry::mark_spent(nullifierHash)
  8. transfer(denomination_lamports, stealth_address)
```

---

## lending_pool

### Account Model

```
LoanAccount (PDA per loan_id)
  - collateral_nullifier_hash: [u8; 32]
  - collateral_denomination_class: u8     // index into DENOMINATION_TABLE
  - loan_id: u64
  - disbursed_at: i64
  - status: LoanStatus { Active, Repaid, Liquidated }
  - encrypted_balance: EncryptCiphertext  // FHE-encrypted borrowed amount
  - encrypted_interest: EncryptCiphertext // FHE-encrypted accrued interest

InterestRateModel (singleton PDA)
  - utilization_kinks: [u16; 11]          // basis points — 11-point Kamino model
  - rate_at_kink: [u16; 11]               // annual rate at each kink
  - last_updated: i64
```

### Instructions

| Instruction | Signer | Purpose |
|---|---|---|
| `borrow` | Any (proof-gated) | Verify collateral proof, create LoanAccount, CPI → IKA disburse to stealth address |
| `repay` | Any (proof-gated) | Verify repay_ring proof, clear LoanAccount, unlock nullifier |
| `liquidate` | IKA FutureSign trigger | Execute pre-authorized liquidation when health_factor breached |
| `update_rate` | Governance | Update interest rate kink table |

### Borrow Flow

```
Client:
  1. Select collateral note (secret, nullifier, denomination)
  2. Choose borrow amount (must satisfy: denomination × LTV_BPS ≥ borrowed × 10000)
  3. snarkjs.groth16.fullProve(collateral_ring, inputs) → proof
  4. Generate fresh Umbra stealth address for loan disbursement
  5. Submit borrow instruction with proof + stealth_address + loan_amount

On-chain (lending_pool::borrow):
  6. groth16_solana::verify(proof, publicSignals, COLLATERAL_VK_HASH)
  7. Verify nullifier not spent (collateral locked, not consumed)
  8. CPI → nullifier_registry::lock_nullifier(nullifierHash)
  9. Create LoanAccount (FHE-encrypt balance + interest = 0)
  10. CPI → IKA::approve_message(disbursement_params)
       → IKA MPC network validates + co-signs
  11. CPI → shielded_pool::disburse(loan_amount, stealth_address)
```

### Repay Flow

```
Client:
  1. Load collateral note to regenerate nullifier
  2. Submit repaymentAmount claim + generate repay_ring proof
  3. Send repaymentAmount SOL via IKA relay
  4. Submit repay instruction with proof

On-chain (lending_pool::repay):
  5. groth16_solana::verify(proof, publicSignals, REPAY_VK_HASH)
  6. Encrypt FHE verifies repaymentAmount >= totalOwed (on encrypted values)
  7. CPI → nullifier_registry::unlock_nullifier(nullifierHash)
  8. Close LoanAccount
  9. CPI → IKA::approve_message(collateral_unlock)
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

Interest accrues to FHE ciphertext accounts — validators see no amounts.

---

## nullifier_registry

### Account Model

```
NullifierAccount (PDA: seeds = [b"nullifier", nullifier_hash])
  - nullifier_hash: [u8; 32]
  - status: NullifierStatus { Active, Locked, Spent }
  - registered_at: i64

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
  pathElements[24], pathIndices[24]   // Merkle inclusion proof
  ring[16]                            // ring of K=16 commitments
  own_index                           // which ring element is yours

Public outputs:
  ring[16]                            // revealed ring (for nullifier checking)
  nullifierHash = Poseidon(nullifier)
  root                                // Merkle root matched
  denomination_out                    // denomination being withdrawn

Constraints:
  commitment = Poseidon(secret, nullifier, denomination)
  ring[own_index] == commitment
  MerkleInclude(commitment, pathElements, pathIndices) == root
  nullifierHash = Poseidon(nullifier)
```

### collateral_ring.circom

```
Private inputs:
  secret, nullifier, denomination
  pathElements[24], pathIndices[24]
  ring[16], own_index
  borrowed                            // loan amount
  minRatioBps                         // LTV floor in basis points

Public outputs:
  ring[16], nullifierHash, root
  borrowed, minRatioBps               // for on-chain LTV verification

Constraints:
  commitment = Poseidon(secret, nullifier, denomination)
  ring[own_index] == commitment
  MerkleInclude(commitment, ...) == root
  denomination * minRatioBps >= borrowed * 10000   // LTV check in-circuit
```

### repay_ring.circom

```
Private inputs:
  nullifier                           // proves knowledge of collateral secret
  repaymentAmount
  borrowerWallet                      // never revealed on-chain

Public outputs:
  nullifierHash = Poseidon(nullifier) // matches locked nullifier in registry
  loanId                              // identifies which loan PDA to clear

Constraints:
  nullifierHash = Poseidon(nullifier)
  // repaymentAmount >= totalOwed enforced by Encrypt FHE on ciphertext
```

---

## MagicBlock PER + ER — Parallel Operation

```
MagicBlock PER (Private Ephemeral Rollup)
  Delegates: shielded_pool deposit queue accounts
  Intel TDX enclave: deposit→commitment mapping hidden inside enclave
  Settlement: fraud-provable state commit to base Solana
  Privacy: REQUIRED

MagicBlock ER (Standard Ephemeral Rollup, 1ms blocks)
  Delegates: lending_pool health monitor state
  Liquidation bot: continuous health_factor polling
  Settlement: standard ephemeral rollup commit
  Privacy: NOT REQUIRED
```

Different PDAs are delegated to different rollup environments. Both run simultaneously without conflict. Anchor programs support multiple PDA sets delegated independently.

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

## Encrypt FHE Account Pattern

```rust
#[encrypt_fn]
fn accrue_interest(
    balance: EncryptCiphertext,
    rate: EncryptCiphertext,
    elapsed: u64,
) -> EncryptCiphertext {
    // Homomorphic multiplication — no plaintext ever materialized
    balance + (balance * rate * elapsed / SECONDS_PER_YEAR)
}
```

Threshold decryption (2/3 IKA MPC) used for:
1. **Aggregate solvency**: `Σ(balance[i])` → single decrypt → total outstanding, no individual exposure
2. **Targeted audit**: single `loanId` balance decrypted for compliance disclosure
