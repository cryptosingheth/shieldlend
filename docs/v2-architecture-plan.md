# ShieldLend V2 Architecture Plan
**Finalized:** 2026-03-31 | **Branch:** `v2-architecture` | **Status:** Pending contributor review

---

## V1 → V2 Summary

V1 (deployed on Base Sepolia) proved the core concept: shielded ETH deposits, ZK withdrawals via Groth16 proofs verified through zkVerify Volta, and a basic lending pool. 57 tests passing, live on-chain.

V2 is the production redesign: a unified pool architecture, four independent privacy layers, a critical solvency fix, and encrypted note storage. All changes stay on Base + Circom/Groth16/zkVerify — no external VM dependency.

---

## Architecture Changes (V2 Contract Design)

### Unified ETH Pool

LendingPool becomes **pure accounting** — it holds no ETH. ShieldedPool is the single ETH vault for all deposits, withdrawals, and loan disbursements.

| Function | ETH direction | Notes |
|----------|--------------|-------|
| `deposit()` | User → ShieldedPool | Commitment queued for epoch flush |
| `withdraw()` | ShieldedPool → stealth recipient | ZK proof + nullifier spend |
| `borrow()` disbursement | ShieldedPool → stealth recipient | Called by LendingPool after collateral proof |
| `repay()` | User → ShieldedPool | LendingPool records repayment state |

Since withdrawals and borrow disbursements come from the same contract at the same denomination amounts, they are indistinguishable on-chain.

**Why keep LendingPool separate:** ShieldedPool is the single point of failure for ETH custody — this is unavoidable with one vault. The separation reduces the blast radius of LendingPool bugs specifically: complex interest, liquidation, and collateral logic lives in LendingPool, which can only interact with ShieldedPool through gated entry points (`lockNullifier`, `disburseLoan`, `settleCollateral`). A logic exploit in LendingPool hits accounting — it cannot arbitrarily drain ETH, because every exit is independently validated by ShieldedPool. ShieldedPool itself is kept minimal to reduce its own attack surface.

### Fixed Denominations (Single Pool)

One ShieldedPool accepts deposits of exactly 0.1, 0.5, or 1.0 ETH. All commitments share the same Merkle tree and anonymity set — no per-denomination fragmentation.

Borrow amounts are fixed ratios of the denomination (50%, 60%, 70%) — 9 loan options in total. This prevents the borrow amount from uniquely fingerprinting the collateral denomination while keeping the UX simple.

The `Borrowed` event emits only `loanId` — no amount, no recipient. The ETH transfer amount is visible in the transaction trace but not indexed in event logs.

---

## Part A — Solvency Fix + Auto-Settle Withdrawal

### The Bug

`ShieldedPool.withdraw()` only checks `NullifierRegistry.isSpent()`. It does not check whether the nullifier is locked as active collateral in LendingPool. A user can borrow against a note, then withdraw that same note — collateral is gone, loan stays open, protocol is insolvent.

### Fix: Nullifier Lock + Auto-Settlement

When `LendingPool.borrow()` is called, it locks the collateral nullifier in ShieldedPool:

```solidity
// ShieldedPool.sol additions:
address public lendingPool;
mapping(bytes32 => bool) public lockedAsCollateral;
error InsufficientCollateralForSettlement();

function setLendingPool(address _lp) external onlyAdmin { lendingPool = _lp; }

function lockNullifier(bytes32 n) external {
    require(msg.sender == lendingPool, "only LendingPool");
    lockedAsCollateral[n] = true;
}
```

`withdraw()` auto-settles the loan instead of reverting when collateral is locked:

```solidity
// In ShieldedPool.withdraw(), before NullifierRegistry check:
if (lockedAsCollateral[nullifierHash]) {
    uint256 totalOwed = ILendingPool(lendingPool).getOwed(nullifierHash);
    if (amount < totalOwed) revert InsufficientCollateralForSettlement();
    ILendingPool(lendingPool).settleCollateral{value: totalOwed}(nullifierHash);
    recipient.call{value: amount - totalOwed}("");
    nullifierRegistry.markSpent(nullifierHash);
    emit Withdrawal(recipient, nullifierHash, amount - totalOwed);
    return;
}
```

```solidity
// LendingPool.sol additions:
address public shieldedPool;

function setShieldedPool(address _sp) external onlyAdmin { shieldedPool = _sp; }

function getOwed(bytes32 nullifierHash) external view returns (uint256) {
    uint256 loanId = activeLoanByNote[nullifierHash];
    Loan storage l = loans[loanId];
    return l.borrowed + _calculateInterest(l.borrowed, l.timestamp);
}

function settleCollateral(bytes32 nullifierHash) external payable {
    require(msg.sender == shieldedPool, "only ShieldedPool");
    uint256 loanId = activeLoanByNote[nullifierHash];
    Loan storage l = loans[loanId];
    uint256 totalOwed = l.borrowed + _calculateInterest(l.borrowed, l.timestamp);
    require(msg.value >= totalOwed);
    l.repaid = true;
    hasActiveLoan[nullifierHash] = false;
    emit Repaid(loanId, totalOwed);
}
```

In `LendingPool.borrow()`: call `shieldedPool.lockNullifier(noteNullifierHash)` after collateral proof passes.

Manual `repay()` remains — users can repay the loan while keeping their collateral note active (e.g., to borrow again).

**Frontend UX:** Before user confirms withdrawal, fetch `hasActiveLoan(nullifierHash)`. If true, fetch `getOwed()` and show: "This note has an outstanding loan of X ETH. You will receive [amount − totalOwed] ETH after auto-repayment." If `amount < totalOwed`, show error and link to Borrow tab.

**Deploy.s.sol:** After deploying both contracts, call `shieldedPool.setLendingPool(lendingPoolAddr)` and `lendingPool.setShieldedPool(shieldedPoolAddr)`.

**Redeployment required.**

---

## Part B — Note Security + On-Load Nullifier Sync

### B1: Note Encryption

`StoredNote` currently stores `nullifier` and `secret` in plaintext localStorage. Anyone who reads localStorage (XSS, malicious extension, physical access) can generate a valid ZK proof and withdraw funds to any address.

**Fix:** Encrypt notes with AES-256-GCM using a key derived from a deterministic wallet signature:

```typescript
// frontend/src/lib/noteKeyContext.tsx (new)
// Key = HKDF(keccak256(signMessage("ShieldLend note key v1 {address}")))
// Held in React context memory — never written to disk
async function deriveKey(signatureHex: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", hexToBytes(signatureHex), "HKDF", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encodeText("shieldlend-notes") },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
```

`noteStorage.ts` is updated so `saveNote(address, note, key, txHash?)` encrypts the notes array, and `loadNotes(address, key)` decrypts. Fallback: if no key is present, read plaintext (migration path from V1 storage).

The signing prompt fires once per session on wallet connect. The same wallet produces the same key on any device — notes are portable.

**Files:** `noteStorage.ts` (encryption/decryption), `noteKeyContext.tsx` (new), `Dashboard.tsx` + `DepositForm.tsx` + `WithdrawForm.tsx` (pass key from context).

### B2: On-Load Nullifier Sync

Dashboard reads notes from localStorage only. If localStorage is cleared or a different device is used, spent notes appear as "Active." The on-chain source of truth is `NullifierRegistry.isSpent()`.

On dashboard load, for each "Active" note, query the registry and mark spent if confirmed:

```typescript
// contracts.ts additions:
export const NULLIFIER_REGISTRY_ADDRESS = "0xb297fC52b3F831c36f828539C7F0456fbD587fb6" as const;
export const NULLIFIER_REGISTRY_ABI = parseAbi([
  "function isSpent(bytes32 nullifierHash) view returns (bool)",
]);

// Dashboard.tsx fetchStats() — after loading notes:
const activeNotes = loadNotes(address, noteKey).filter(n => !n.spent);
for (const note of activeNotes) {
  if (signal?.aborted) break;
  const spent = await publicClient.readContract({
    address: NULLIFIER_REGISTRY_ADDRESS,
    abi: NULLIFIER_REGISTRY_ABI,
    functionName: "isSpent",
    args: [note.nullifierHash as `0x${string}`],
  });
  if (spent) markNoteSpent(address, note.nullifierHash, noteKey);
}
setSavedNotes(loadNotes(address, noteKey));
```

---

## Part C — Hybrid Privacy Architecture (Four Layers)

### Goal

Timing correlation in current ZK privacy protocols (Tornado Cash pattern) is user-base dependent: a sparse pool with few deposits is easily de-anonymized by timing. V2 implements four independent layers that together provide strong privacy guarantees regardless of pool size.

No production protocol currently combines all four layers.

---

### Layer 1: ZK Circuit (retained from V1)

Groth16 proof + nullifier prevents linking deposit to withdrawal at the cryptographic level. This layer is already implemented and remains unchanged.

---

### Layer 2: Epoch Batch Insertion

**Problem:** Immediate commitment insertion lets an observer correlate the deposit transaction timestamp with the Merkle leaf index. Even without knowing the note contents, timing + position gives a strong signal.

**Fix:** Commitments queue in `pendingCommitments[]` on-chain. Every 50 blocks (~10 minutes on Base), anyone can call `flushEpoch()` which inserts all queued commitments in one batch. Insertion order within the epoch is randomized using `block.prevrandao` (BFT-safe post-Merge randomness):

```solidity
bytes32[] public pendingCommitments;
uint256 public lastEpochBlock;
uint256 public epochNumber;
uint256 public constant EPOCH_BLOCKS = 50;

function deposit(bytes32 commitment) external payable {
    require(msg.value == 0.1 ether || msg.value == 0.5 ether || msg.value == 1.0 ether, "invalid denomination");
    pendingCommitments.push(commitment);
    emit Deposit(commitment, block.timestamp, msg.value);
}

function flushEpoch() external {
    require(block.number >= lastEpochBlock + EPOCH_BLOCKS, "too early");
    bytes32 seed = keccak256(abi.encodePacked(block.prevrandao, epochNumber));
    uint256[] memory order = _shuffleIndices(pendingCommitments.length, seed);
    for (uint i = 0; i < pendingCommitments.length; i++) {
        _insert(pendingCommitments[order[i]]);
    }
    delete pendingCommitments;
    lastEpochBlock = block.number;
    epochNumber++;
}
```

`flushEpoch()` is permissionless — anyone can call it. A small tip from `protocolFunds` (collected via 0.1% deposit fee) incentivizes calling. No keeper required.

**Pending commitment security:** Commitments stored in `pendingCommitments[]` are on-chain and immutable. `flushEpoch()` being permissionless means no single party controls which epoch a commitment lands in. `prevrandao` prevents manipulation of insertion order.

---

### Layer 3: Protocol-Inserted Dummy Commitments

**Problem:** Even with epoch batching, a sparse pool still reveals timing patterns if only one or two real deposits occurred in a window.

**Fix:** During each `flushEpoch()`, the contract inserts D dummy commitments — valid Merkle leaves with no ETH behind them and no known preimage. An observer cannot distinguish real deposits from dummies.

**Adaptive density:** The dummy count starts at 10/epoch when the pool is sparse and reduces to a minimum of 2 as real deposits accumulate. Dummies are most critical at launch; as the protocol matures, real historical commitments become the noise floor on their own.

**Dummy values use `block.prevrandao`** — not predictable before the block is finalized, so dummies cannot be pre-identified by an attacker.

**Tree sizing:** Upgrade depth from 20 (1M leaves) to 24 (16M leaves) to accommodate dummies over the protocol lifetime.

**Funding:** 0.1% deposit fee → `protocolFunds`. Caller of `flushEpoch()` receives a small tip. Gas cost is $0.01–$0.10/epoch at Base typical prices — well within protocol fee revenue.

Inside `flushEpoch()`, after inserting real commitments:

```solidity
uint256 public constant DUMMIES_PER_EPOCH = 10;

for (uint d = 0; d < _dummiesForEpoch(); d++) {
    bytes32 dummy = keccak256(abi.encodePacked(block.prevrandao, epochNumber, d));
    _insert(dummy);
}

function _dummiesForEpoch() internal view returns (uint256) {
    uint256 realCount = nextIndex - epochNumber * DUMMIES_PER_EPOCH;
    if (realCount < 200) return 10;
    if (realCount < 1000) return 5;
    return 2;
}
```

---

### Layer 4: Time-Windowed Ring Selection (New Circuit)

**Problem:** Standard ZK withdrawal proves membership in the entire tree but doesn't constrain the ring of decoys. An observer using timing statistics can narrow the candidate set.

**Fix:** A new `withdraw_ring.circom` forces the prover to commit to an explicit ring of k=16 commitments spanning the last 30 epochs. The prover proves membership in that ring — the ring covers real and dummy commitments from a time window, completely decoupling withdrawal timing from deposit timing.

**Circuit signals:**

Private inputs: `secret s` (note preimage), `Merkle path for C_real` (inclusion proof), `ring_index i` (position of real commitment in ring, 0–15).

Public inputs: `ring[0..15]` (16 commitments from last 30 epochs), `nullifier N = Poseidon(s, i)`, `Merkle root R`.

Constraints enforced:
1. `C_real = Poseidon(denomination, s)` — valid commitment
2. `C_real == ring[i]` — ring membership
3. `merkleVerify(C_real, path, R)` — global tree inclusion
4. `N == Poseidon(s, i)` — nullifier binds to ring position

Ring is selected by the withdrawing user from the last 30 epochs. With 10 dummies/epoch × 30 epochs = 300 minimum commitments in range, even at protocol launch with zero real users, the effective anonymity set is 300. This is user-base independent.

**Circuit cost:** ~24k constraints vs. current ~8k. Proof generation increases from ~10s to ~25s. Acceptable for browser-based proving.

**The same ring approach applies to `collateral_ring.circom`** — the borrow proof commits to a ring of collateral commitments, so the on-chain proof does not reveal which specific note is the collateral.

**New trusted setup required** (new `.zkey` per circuit → new `vkHash` → redeploy). Existing Powers of Tau file can be reused.

---

### Layer 4 Supplement: ERC-5564 Stealth Addresses

**Problem:** Withdrawal recipient address is a public input — linking the recipient identity to the on-chain withdrawal transaction.

**Fix:** Recipients use ERC-5564 stealth addresses — one-time addresses derived from a published meta-address via ECDH. The real recipient's identity cannot be linked to the stealth address on-chain.

**How it works:**
1. Recipient publishes a stealth meta-address in ERC6538Registry
2. Withdrawer calls `generateStealthAddress(metaAddress)` via SDK → gets `{ stealthAddress, ephemeralPubKey, viewTag }`
3. `stealthAddress` is passed as `recipient` in the withdraw transaction (still a public input, but now unlinkable to the real recipient's identity)
4. After tx confirms, withdrawer announces `(schemeId, stealthAddress, ephemeralPubKey, viewTag)` to ERC5564Announcer
5. Real recipient scans announcements, identifies their notification via view tag, derives the private key for the stealth address

**Deployed addresses (same on all EVM chains including Base Sepolia):**
- `ERC5564Announcer`: `0x55649E01B5Df198D18D95b5cc5051630cfD45564`
- `ERC6538Registry`: `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`

**SDK:** `@scopelift/stealth-address-sdk` (TypeScript, wagmi/viem compatible)

No circuit changes needed for basic integration. The `recipient` field already exists as a public input.

---

### Combined Privacy Guarantees

| Layer | What it hides | How |
|-------|--------------|-----|
| 1: ZK circuit | Which deposit = this withdrawal (transaction graph) | Groth16 + nullifier |
| 2: Epoch batch | Deposit transaction timestamp vs. Merkle leaf timing | Batched insertion + prevrandao shuffle |
| 3: Dummy commitments | Sparse pool — user-base independent | Adaptive dummies per epoch |
| 4: Ring selection | Which commitment in the time window | withdraw_ring.circom (k=16) |
| 4+: Stealth addresses | Recipient identity on withdrawal/borrow | ERC-5564 |

Combined result on Base: an observer sees ETH leaving ShieldedPool to an unlinkable stealth address — they cannot determine which deposit it corresponds to, when the depositor deposited, or who the recipient is.

---

## Interest Rate + Liquidation Redesign

### Lending Mechanics (Protocol Overview)

Every ETH deposit into ShieldedPool contributes to a shared liquidity pool. Borrowers ZK-prove ownership of a note as collateral and draw ETH from that same pool. There is no separate lender/borrower role — depositors ARE the liquidity providers. Interest accrues to the protocol (future: distributable to depositors).

Since both collateral and borrowed asset are ETH, no price oracle is required. This removes oracle risk (price manipulation, feed failures) and simplifies the health factor to a pure ratio.

### Interest Rate: Utilization Curve (Aave v3 Model)

V1 uses a flat rate (`interestRateBps`). V2 replaces it with the same kinked two-slope model used by Aave v3:

`utilization = totalBorrowed / totalDeposited`

Below the kink (U ≤ U_optimal): `rate = R_base + (U / U_optimal) × R_slope1`

Above the kink (U > U_optimal): `rate = R_base + R_slope1 + ((U - U_optimal) / (1 - U_optimal)) × R_slope2`

Parameters: R_base=1%, R_slope1=4%, U_optimal=80%, R_slope2=40%. Rate rises gradually up to 80% utilization, then steeply above it to incentivize repayment and protect pool liquidity.

### Liquidation: Collateral-Ratio-Based (Aave v3 Style)

V1 used time-based liquidation. V2 replaces it with health factor liquidation, matching Aave v3.

Since collateral and loans are both ETH, no oracle is needed. Health factor: `HF = (collateralAmount × liquidationThreshold) / totalOwed`

A position is liquidatable when HF < 1. A healthy position requires HF ≥ 1.1 (10% safety buffer at borrow time). Suggested liquidation threshold: 90% (meaning 0.9 ETH of a 1.0 ETH note can cover borrowing before liquidation triggers).

Since each note maps to exactly one loan, the close factor is 100% — the full debt is settled in a single liquidation call (no partial close needed). Liquidators receive a 5% bonus on the collateral. Any remaining collateral after debt + bonus is sent to the protocol treasury.

At borrow time, the collateral denomination is included as a public signal in the ZK proof (denomination is already public since it's one of three fixed values). This enables the on-chain check:

```solidity
function canLiquidate(uint256 loanId) public view returns (bool) {
    Loan storage l = loans[loanId];
    uint256 totalOwed = l.borrowed + _calculateInterest(l.borrowed, l.timestamp);
    return (l.collateralAmount * l.liquidationThreshold) / 10000 < totalOwed;
}
```

**Privacy impact:** Neither the interest rate model nor the liquidation model affect the four privacy layers. Both operate at the accounting layer only. A liquidation event reveals that loan `loanId` was settled, but not which note was the collateral — `activeLoanByNote` is private contract state and the `Borrowed` event does not index the nullifier hash.

---

## Implementation Plan

### Phase 1 — Contract Rewrite + Redeploy

| File | Change |
|------|--------|
| `contracts/src/ShieldedPool.sol` | Unified pool: denomination validation, epoch queue + flush, dummy insertion, lockNullifier, disburseLoan, auto-settle in withdraw(), depth-24 tree |
| `contracts/src/LendingPool.sol` | Accounting-only: setShieldedPool, getOwed, settleCollateral, utilization-curve interest, ratio-based liquidation, no ETH custody |
| `contracts/src/interfaces/ILendingPool.sol` | Add getOwed(), settleCollateral(), disburseLoan() |
| `contracts/script/Deploy.s.sol` | Deploy all, call setLendingPool + setShieldedPool post-deploy |
| `contracts/test/ShieldedPool.t.sol` | Epoch flush, dummy count, denomination validation, auto-settle, unified disbursement |
| `contracts/test/LendingPool.t.sol` | Utilization rate, liquidation trigger, auto-settle integration |

Redeploy to Base Sepolia. Update `.env.local`.

### Phase 2 — New ZK Circuits + Trusted Setup

| File | Change |
|------|--------|
| `circuits/withdraw_ring.circom` | Ring membership (k=16) + Merkle inclusion + nullifier binding |
| `circuits/collateral_ring.circom` | Ring-based collateral proof + denomination as public signal |
| `contracts/src/verifiers/WithdrawRingVerifier.sol` | Generated from new zkey via snarkjs |
| `contracts/src/verifiers/CollateralRingVerifier.sol` | Generated from new zkey |

Commands: `snarkjs groth16 setup` → `snarkjs zkey contribute` → `snarkjs zkey export verificationKey` → `snarkjs zkey export solidityverifier`. New `vkHash` from verification key → update Deploy.s.sol → redeploy.

### Phase 3 — Frontend

| File | Change |
|------|--------|
| `frontend/src/lib/noteStorage.ts` | AES-GCM encryption/decryption |
| `frontend/src/lib/noteKeyContext.tsx` | Session encryption key context (new) |
| `frontend/src/lib/contracts.ts` | NULLIFIER_REGISTRY_ABI, updated LENDING_POOL_ABI |
| `frontend/src/components/Dashboard.tsx` | On-load NullifierRegistry sync |
| `frontend/src/components/WithdrawForm.tsx` | Auto-settle preview, ERC-5564 stealth address input |
| `frontend/src/components/BorrowForm.tsx` | ERC-5564 stealth address for disbursement recipient |
| `frontend/src/app/api/zkverify/route.ts` | Pass ring selection to withdraw_ring circuit |
| `package.json` | Add `@scopelift/stealth-address-sdk` |

---

## Verification Checklist

- `forge test` passes all tests including new solvency tests
- Live: deposit → borrow → attempt withdraw collateral in one tx → verify net ETH + loan repaid
- `snarkjs verify` passes on ring proof; fails for non-ring-member commitment
- Clear localStorage → reload → spent notes appear as "Spent" from chain
- Change wallet device → notes decrypt with same wallet on new device
- Withdrawal goes to stealth address → real recipient scans announcement and recovers funds

---

## Delivery

1. This plan pushed to `v2-architecture` branch for contributor review
2. V1 state preserved via git history + `docs/v1-summary.md`
3. After approval: implement on `v2-contracts` branch → merge to main → tag `v2.0.0`
