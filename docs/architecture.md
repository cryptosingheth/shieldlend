# ShieldLend — System Architecture

---

## Overview

ShieldLend has four layers:

1. **Browser** — user-facing UI, wallet connection, in-browser proof generation (no trusted server)
2. **ZK Circuits** — Circom circuits compiled to WASM; run client-side to produce Groth16 proofs
3. **Smart Contracts** — Solidity on Horizen L3; handle on-chain state (Merkle tree, nullifiers, funds)
4. **zkVerify** — off-chain proof verification chain; proofs submitted here are 91% cheaper to verify than on Ethereum L1

---

## Full System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  USER BROWSER                                                   │
│  Next.js + wagmi + snarkjs (WASM)                               │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Deposit UI      │  │  Withdraw UI     │  │  Collateral   │  │
│  │  1. Enter amount │  │  1. Enter secret │  │  Proof UI     │  │
│  │  2. Generate     │  │  2. Generate     │  │               │  │
│  │     secret       │  │     Merkle proof │  │  1. Prove     │  │
│  │  3. Compute      │  │  3. Generate     │  │     ratio >   │  │
│  │     commitment   │  │     nullifier    │  │     threshold │  │
│  │  4. Submit tx    │  │  4. Submit proof │  │               │  │
│  └──────────────────┘  └──────────────────┘  └───────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ wallet tx + proof
┌──────────────────────────────▼──────────────────────────────────┐
│  ZK CIRCUITS (Circom — compiled to WASM, run in browser)        │
│                                                                 │
│  deposit.circom                                                 │
│  ─────────────                                                  │
│  private inputs:  amount, secret, nullifier                     │
│  public outputs:  commitment = Pedersen(amount || secret)       │
│                   nullifierHash = Poseidon(nullifier)           │
│                                                                 │
│  withdraw.circom                                                │
│  ────────────────                                               │
│  private inputs:  secret, nullifier, pathElements[], indices[]  │
│  public inputs:   root (Merkle root), recipient address         │
│  public outputs:  nullifierHash                                 │
│  constraints:     Merkle membership + nullifier derivation      │
│                                                                 │
│  collateral.circom                                              │
│  ─────────────────                                              │
│  private inputs:  exact_collateral_amount                       │
│  public inputs:   min_ratio, borrowed_amount                    │
│  constraints:     exact_collateral * 100 >= min_ratio * borrowed│
└──────────────────────────────┬──────────────────────────────────┘
                               │ Groth16 proof
              ┌────────────────┴────────────────┐
              │                                 │
┌─────────────▼──────────────┐  ┌──────────────▼──────────────┐
│  SMART CONTRACTS           │  │  ZKVERIFY CHAIN             │
│  (Solidity on Horizen L3)  │  │                             │
│                            │  │  1. Receive proof via       │
│  ShieldedPool.sol          │  │     zkVerifyJS SDK          │
│  ─────────────────         │  │                             │
│  • Incremental Merkle tree │  │  2. Verify Groth16 proof    │
│  • insertCommitment()      │  │     (91% cheaper than L1)   │
│  • getRoot() → Merkle root │  │                             │
│  • MerkleProof events      │  │  3. Emit attestation event  │
│                            │  │                             │
│  NullifierRegistry.sol     │  │  4. Relayer reads event     │
│  ──────────────────────    │  │     → calls back to         │
│  • mapping: nullifier→bool │  │       ShieldedPool.sol      │
│  • markSpent(nullifier)    │  │                             │
│  • isSpent(nullifier)      │  └─────────────────────────────┘
│                            │
│  LendingPool.sol           │
│  ────────────────          │
│  • Forked from Aave V3     │
│  • deposit(commitment)     │
│  • borrow(proof, amount)   │
│  • repay()                 │
│  • withdraw(proof)         │
│  • Calls NullifierRegistry │
└────────────────────────────┘

Deployment: Horizen L3 testnet  (fallback: Base Sepolia)
```

---

## Data Flow — Private Deposit

```
1. User opens ShieldLend frontend and connects wallet
2. User enters deposit amount (e.g., 1 ETH)
3. Browser generates locally (never sent to any server):
   secret        = crypto.getRandomValues(32 bytes)
   nullifier     = crypto.getRandomValues(32 bytes)
   commitment    = Pedersen(amount || secret)    ← deposit.circom
   nullifierHash = Poseidon(nullifier)           ← deposit.circom
4. Browser runs deposit.circom WASM → Groth16 proof of correct commitment
5. User receives a "note" = { amount, secret, nullifier, commitment, leafIndex }
   → THIS IS THE ONLY WAY TO WITHDRAW — back it up securely
6. Frontend calls ShieldedPool.deposit(commitment) with ETH attached
7. Contract verifies proof → inserts commitment into Merkle tree → emits CommitmentInserted event
8. ETH held in ShieldedPool contract
```

---

## Data Flow — Private Withdrawal

```
1. User loads their note (amount, secret, nullifier) — from local file or manual entry
2. Frontend fetches current Merkle root from ShieldedPool.getRoot()
3. Frontend reconstructs Merkle path for the commitment from on-chain CommitmentInserted events
4. Browser runs withdraw.circom WASM → Groth16 proof proving:
   - "This commitment exists in the Merkle tree at the given root"  (Merkle membership)
   - "I know the secret that generated it"                          (preimage knowledge)
   - "I haven't used this nullifier before"                         (fresh nullifier)
5. Frontend sends proof + nullifierHash + root + recipient to zkVerifyJS SDK
6. zkVerify chain verifies the Groth16 proof → emits ProofAttestation event with attestation ID
7. Relayer (or frontend directly) calls ShieldedPool.withdraw(attestationId, nullifierHash, root, recipient)
8. Contract checks:
   - Attestation ID is valid and from zkVerify ✓
   - Root is a known historical root ✓
   - NullifierRegistry.isSpent(nullifierHash) == false ✓
9. NullifierRegistry.markSpent(nullifierHash) — prevents double-withdrawal
10. ETH sent to recipient address
    → No on-chain link between deposit address and withdrawal address
```

---

## Smart Contract Interfaces

```solidity
// ShieldedPool.sol
interface IShieldedPool {
    function deposit(bytes32 commitment) external payable;

    function withdraw(
        bytes32 attestationId,      // from zkVerify
        bytes32 nullifierHash,      // prevent double-spend
        bytes32 root,               // Merkle root at time of deposit
        address payable recipient   // where to send funds
    ) external;

    function getRoot() external view returns (bytes32);
    function isKnownRoot(bytes32 root) external view returns (bool);

    event CommitmentInserted(bytes32 indexed commitment, uint32 leafIndex, bytes32 newRoot);
    event Withdrawal(bytes32 indexed nullifierHash, address indexed recipient);
}

// NullifierRegistry.sol
interface INullifierRegistry {
    function isSpent(bytes32 nullifierHash) external view returns (bool);
    function markSpent(bytes32 nullifierHash) external; // onlyShieldedPool
}

// LendingPool.sol (extends ShieldedPool with borrow mechanics)
interface ILendingPool {
    function borrow(
        bytes calldata collateralProof, // prove collateral > min ratio (collateral.circom)
        bytes32 collateralAttestation,  // from zkVerify
        uint256 borrowAmount,
        bytes32 collateralNullifier     // ties borrow to a specific shielded deposit
    ) external;

    function repay(bytes32 collateralNullifier) external payable;
}
```

---

## zkVerify Integration

zkVerify is a modular proof verification chain. Instead of each dApp deploying its own on-chain Groth16 verifier (expensive — ~500K gas per call on Ethereum L1), zkVerify provides a shared verification service.

```
PROOF SUBMISSION FLOW

Browser (withdraw.circom proof)
        │
        ▼
zkVerifyJS SDK
  ZkVerifySession.start().Testnet().withWallet(relayerWallet)
        │
        ▼
zkVerify Chain
  • Accepts Groth16 proof + verification key
  • Verifies the proof (amortized cost — 91% cheaper than L1 verification)
  • Emits: ProofAttestation { attestationId, proofHash, timestamp }
        │
        ▼
Relayer (watches for ProofAttestation events)
        │
        ▼
ShieldedPool.withdraw(attestationId, ...)
  • Queries zkVerify: isAttestationValid(attestationId) == true
  • Proceeds with withdrawal
```

**Why not on-chain verification?**
On Ethereum L1, a `verifyProof()` call for a Groth16 proof costs ~500,000 gas. At 20 gwei and $3,000/ETH, that is ~$30 per withdrawal. zkVerify amortizes verification across all proof submitters, reducing the per-user cost by ~91%.

---

## Merkle Tree Design

- **Depth**: 20 levels → 2^20 = 1,048,576 possible commitments
- **Hash function**: Poseidon (ZK-friendly — far fewer constraints than SHA-256 in a Circom circuit)
- **Type**: Incremental Merkle tree — new leaves appended at the next available index; no full tree rebuild on each deposit
- **Historical roots**: Contract stores the last N roots so that users who deposited before recent deposits can still withdraw with their old root

```
Level 20 (root):  H(H(H(...)))
Level 19:         H(L, R)
...
Level 0 (leaves): [commitment_0, commitment_1, ..., commitment_N, 0, 0, ...]
                                                    ^ next insert here
```
