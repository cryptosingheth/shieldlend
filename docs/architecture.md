# ShieldLend V2A — System Architecture

**Branch**: `v2a-architecture` | **Network**: Base Sepolia (chain ID 84532) | **Phase**: V2A deployed; V2A+ privacy features in development

See [`docs/privacy-architecture.md`](privacy-architecture.md) for the complete privacy model — including stealth addresses, deposit relay, viewing keys, encrypted notes, and CREATE2 shard factory with cross-shard withdrawal.

---

## Overview

ShieldLend V2A has five deployed privacy layers:

1. **Browser** — Next.js UI, wallet connection, in-browser ring proof generation (snarkjs WASM), note encryption (AES-256-GCM)
2. **ZK Circuits** — Circom ring circuits compiled to WASM; run client-side to produce Groth16 proofs
3. **Smart Contracts** — Solidity on Base Sepolia; single ETH vault (ShieldedPool) + accounting-only lending (LendingPool)
4. **zkVerify** — Off-chain proof verification (Volta testnet); single-leaf aggregation root posted to ShieldedPool on-chain
5. **Epoch Batching Layer** — 50-block queuing + Fisher-Yates shuffle + adaptive dummy insertion; breaks timing correlation

---

## V1 vs V2A

| Dimension | V1 | V2A |
|---|---|---|
| ETH custody | ShieldedPool + LendingPool | ShieldedPool only — single unified vault |
| Circuit | withdraw.circom (depth-20, single note) | withdraw_ring.circom (K=16 ring, depth-24) |
| Commitment | Poseidon(nullifier, secret, amount) | Poseidon(secret, nullifier) — 2 inputs, no amount |
| Denominations | Open (any amount) | Fixed: 0.001/0.005/0.01/0.05/0.1/0.5 ETH |
| Deposit insertion | Immediate | Queued 50 blocks, batch-flushed with dummies |
| Anonymity set | Depends on user volume | 300+ at launch (10 dummies x 30 epochs) |
| Note storage | Plaintext localStorage | AES-256-GCM, HKDF key from MetaMask signature |
| Interest model | Flat rate | Aave v3 kinked two-slope utilization curve |
| Liquidation | Time-based | Health factor (HF = collateral x LT / owed) |
| Auto-settle | None | withdraw() atomically repays open loans |

---

## System Diagram

```
USER BROWSER
Next.js + wagmi/viem + snarkjs (WASM) + circomlibjs (Poseidon)

Deposit Tab            Withdraw Tab            Borrow/Repay Tab
Select denomination    Select encrypted note   Select collateral note
Compute commitment     Wait 50-block epoch     Enter borrow amount
Encrypt + save note     OR auto-flush          Ring proof generation
Submit deposit tx      Ring proof (~25s)       zkVerify submission
                       zkVerify submission     borrow() on-chain
                       withdraw() on-chain     Dropdown: auto-load loans

Note Storage: AES-256-GCM
Key = HKDF(keccak("ShieldLend note key"), MetaMask sig seed)

                    |
                    | Groth16 ring proof + tx
           ---------+---------
           |                 |
SMART CONTRACTS         ZKVERIFY VOLTA TESTNET
(Solidity, Base)
                        1. Receive ring proof via /api/zkverify
ShieldedPool.sol        2. Verify Groth16 proof (91% cheaper than L1)
- Single ETH vault      3. Return domainId + aggId
- pendingCommitments[]  4. Route calls submitAggregation(domainId, aggId,
- EPOCH_BLOCKS=50            aggRoot=keccak256(statementHash(...)))
- flushEpoch():
    prevrandao shuffle
    adaptive dummies
    _insert() depth-24
- lockNullifier()
- disburseLoan()
- settleCollateral()
- LEVELS=24

LendingPool.sol
- Accounting only
- Aave v3 two-slope rate
- HF-based liquidation
- hasActiveLoan mapping
- activeLoanByNote mapping
- getLoanDetails()

NullifierRegistry.sol
- isSpent / markSpent
- onlyShieldedPool

ZkVerifyAggregation.sol
- verifyProofAggregation()
- submitAggregation()
```

---

## Data Flow — Private Deposit

```
1. Select denomination: 0.001/0.005/0.01/0.05/0.1/0.5 ETH
2. Browser generates locally (never leaves device):
     secret     = crypto.getRandomValues(32 bytes) as field element
     nullifier  = crypto.getRandomValues(32 bytes) as field element
     commitment = Poseidon(secret, nullifier)   <- V2A: 2 inputs, secret first
3. ShieldedPool.deposit(commitment) called with ETH
4. Contract validates denomination, queues commitment in pendingCommitments[]
   emits: Deposit(commitment, queueIndex, timestamp, amount)
5. Commitment is NOT yet in Merkle tree
6. Browser encrypts note with wallet-derived AES-256-GCM key
7. Every ~50 blocks, flushEpoch() is called:
     - Shuffles pending queue using block.prevrandao
     - Inserts adaptive dummies (2/5/10 based on epoch size)
     - _insert() called for each -> depth-24 Merkle tree updated
     - emits: LeafInserted(commitment, leafIndex)  <- real Merkle position
```

Critical: deposits are NOT immediately withdrawable. The 50-block wait (~100s on Base Sepolia) is a privacy mechanism — batching multiple deposits together breaks timing correlation.

---

## Data Flow — Private Withdrawal

```
1. Decrypt note client-side using wallet-derived key
2. Check for LeafInserted(commitment) event:
   - Found: note is in tree, proceed
   - Not found + epoch ready: auto-trigger flushEpoch() (first MetaMask tx)
   - Not found + epoch not ready: show amber countdown (blocks/seconds)
3. Fetch all LeafInserted events -> reconstruct Merkle tree
4. Build Merkle path (24 siblings) for commitment
5. Build ring: K=16 commitments from last 30 epoch flushes
   ring[ring_index] = prover's real commitment (ring_index is PRIVATE)
   ring[others]     = other real/dummy commitments from recent epochs
6. withdraw_ring.circom WASM -> Groth16 proof (~25s):
   - C_real = Poseidon(secret, nullifier)
   - ring[ring_index] == C_real  (membership - ring_index hidden)
   - C_real is leaf in depth-24 Merkle tree with root R
   - nullifierHash = Poseidon(nullifier, ring_index)
7. Proof -> /api/zkverify -> zkVerify Volta -> { domainId, aggId }
   aggRoot = keccak256(statementHash([root, nullifierHash, uint160(recipient), amount]))
   ZkVerifyAggregation.submitAggregation(domainId, aggId, aggRoot)
8. ShieldedPool.withdraw(root, nullifierHash, recipient, amount,
     domainId, aggId, merklePath=[], leafCount=1, leafIndex=0)
9. verifyProofAggregation -> keccak256(leaf) == aggRoot pass
   markSpent(nullifierHash) -> transfer ETH to recipient
   if loan open: settleCollateral() deducted first
```

---

## Data Flow — Borrow + Repay

```
BORROW
1. Select collateral note (in Merkle tree, no active loan)
2. Enter borrow amount - HF preview: collateral >= 110% of borrow
3. collateral_ring.circom -> Groth16 proof
4. Proof -> /api/zkverify -> attestation
5. LendingPool.borrow(noteNullifierHash, borrowed, collateralAmount, recipient)
   lockNullifier() -> create Loan -> activeLoanByNote -> disburseLoan()
   emits: Borrowed(loanId)  <- only loanId (no amount, no recipient - privacy)

REPAY
1. UI auto-discovers loans: for each vault note:
   hasActiveLoan -> activeLoanByNote -> getLoanDetails
2. Select loan from dropdown (shows loanId, note label, principal shown)
3. handleRepay re-reads getLoanDetails FRESH at click time
   sends freshTotalOwed + 0.1% buffer (interest accrues per block)
   contract refunds any overpayment
```

---

## Smart Contract ABIs (V2A)

```solidity
// ShieldedPool.sol
function deposit(bytes32 commitment) external payable;
function withdraw(bytes32 root, bytes32 nullifierHash, address recipient,
    uint256 amount, uint256 domainId, uint256 aggregationId,
    bytes32[] merklePath, uint256 leafCount, uint256 leafIndex) external;
function flushEpoch() external;
function lockNullifier(bytes32 n) external;               // onlyLendingPool
function disburseLoan(address payable to, uint256 amount) external; // onlyLendingPool
function getLastRoot() external view returns (bytes32);
function lastEpochBlock() external view returns (uint256);
function EPOCH_BLOCKS() external view returns (uint256);
function statementHash(uint256[] inputs) external view returns (bytes32);

// LendingPool.sol
function borrow(bytes32 noteNullifierHash, uint256 borrowed,
    uint256 collateralAmount, address payable recipient) external;
function repay(uint256 loanId) external payable;
function getLoanDetails(uint256 loanId) external view returns (
    bytes32, uint256 borrowed, uint256 currentInterest, uint256 totalOwed, bool repaid);
function hasActiveLoan(bytes32 noteNullifierHash) external view returns (bool);
function activeLoanByNote(bytes32 noteNullifierHash) external view returns (uint256);
```

---

## zkVerify Flow — Single-Leaf Aggregation

```
leaf    = ShieldedPool.statementHash([root, nullifierHash, uint160(recipient), amount])
aggRoot = keccak256(abi.encode(leaf))

ZkVerifyAggregation.submitAggregation(domainId, aggId, aggRoot)

ShieldedPool.withdraw(..., domainId, aggId, merklePath=[], leafCount=1, leafIndex=0)
  -> verifyProofAggregation(domainId, aggId, aggRoot, [], 1, 0, leaf)
  -> Merkle.verifyProofKeccak(aggRoot, [], 1, 0, leaf)
  -> keccak256(leaf) == aggRoot  PASS
```

Required env vars (missing either causes gas estimate 140M error):
- DEPLOYER_PRIVATE_KEY
- ZKVERIFY_AGGREGATION_ADDRESS=0x8b722840538d9101bfd8c1c228fb704fbe47f460

---

## Merkle Tree

- Depth: 24 -> 2^24 = 16,777,216 leaves
- Hash: Poseidon(2) — same as circuits
- Insertion: only at flushEpoch() — tree stable between flushes
- Zero values: zeros[0]=0, zeros[i]=Poseidon(zeros[i-1], zeros[i-1])
- Historical roots: last 30 stored

---

## Interest Rate Model

```
U <= 80%:  rate = 1% + (U/80%) x 4%
U >  80%:  rate = 1% + 4% + ((U-80%)/20%) x 40%

Interest = principal x rate x elapsed / (365 days x 10000)
```

---

## Deployed Contracts — Base Sepolia (V2A current — 3rd deployment post H-1/H-3 fixes)

| Contract | Address |
|---|---|
| ShieldedPool | `0x9365e995F8aF1051db68100677a6C9cf225055A9` |
| LendingPool | `0x1aacF59792404b23287Faa9b0fbC3c9505cc56c9` |
| NullifierRegistry | `0xD0e7D0A083544144a4EFf2ADAa6318E3a28722e7` |
| ZkVerifyAggregation | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` |

zkVerify network: Volta testnet | Domain ID: 0

**Old deployment** (pre H-1/H-3 fix, do not use): ShieldedPool `0xfaeD6bf64a513aCEC9E8f1672d5e6584F869661a`; 0.021 ETH stuck, recovery deferred.
