# ShieldLend V2A — Complete Bug & Fix Report

**Branch**: `v2a-architecture`
**Period covered**: Full V2A development session (2026-03-28 → 2026-04-03)
**Author**: Internal (session 9e2ba90d + continuation)

This document records every bug found during V2A development and testing —
pre-audit fixes, post-audit UI bugs, and runtime errors caught during live
testnet testing on Base Sepolia. Each entry includes root cause, impact,
fix applied, and the commit where it landed.

---

## Index

| ID | Severity | Category | Title | Status |
|---|---|---|---|---|
| B-01 | CRITICAL | Contract | Auto-settle proof bypass | Fixed — `80f0fd5` |
| B-02 | HIGH | Contract | Wrong Merkle leaf index in LeafInserted event | Fixed — `80f0fd5` |
| B-03 | HIGH | Contract | `_dummiesForEpoch` integer underflow | Fixed — `80f0fd5` |
| B-04 | CRITICAL | Circuit/Frontend | Commitment scheme mismatch across all layers | Fixed — `44e219e` |
| B-05 | HIGH | Frontend | NullifierHash formula wrong | Fixed — `44e219e` |
| B-06 | CRITICAL | Frontend | V1 circuit paths — wrong wasm/zkey | Fixed — `44e219e` |
| B-07 | HIGH | Frontend | `generateWithdrawProof` V1 input structure | Fixed — `44e219e` |
| B-08 | MEDIUM | Frontend | NoteKeyProvider not wired in app tree | Fixed — `7f7033f` |
| B-09 | MEDIUM | Frontend | DepositForm calling `saveNote` without encryption key | Fixed — `7f7033f` |
| B-10 | MEDIUM | Contract/UI | Deposit denomination: free-form input + wrong allowed set | Fixed — `eb7fb31` |
| B-11 | HIGH | Frontend | LeafInserted vs Deposit event ambiguity in log matching | Fixed — `b90bd3d` |
| B-12 | HIGH | Frontend | Wrong `DEPLOY_BLOCK` constant | Fixed — `b90bd3d` |
| B-13 | HIGH | Frontend | Epoch not flushed: no user feedback, withdraw silently broken | Fixed — `35b4f73` |
| B-14 | MEDIUM | Frontend | Manual flush required — wrong UX for Approach A | Fixed — `2770e1c` |
| B-15 | HIGH | Frontend | Race condition: `getAllLogs` runs before flush block indexed | Fixed — `607ac0a` |
| B-16 | HIGH | Frontend | Race condition: `noteFlushStatus` effect same issue | Fixed — `7efb2ad` |
| B-17 | LOW | Frontend | Note label collision — same amount same day indistinguishable | Fixed — `9a9032e` |
| B-18 | LOW | Tooling | Dead ptau download URL in `trusted_setup.sh` | Fixed — `f81f7f1` |
| B-19 | LOW | Tooling | VK hash computation broken — `__dirname` + wrong keccak | Fixed — `f81f7f1` |
| B-20 | LOW | Tooling | `foundry.toml` missing from `contracts/` | Fixed — `f81f7f1` |

---

## Detailed Entries

---

### B-01 — Auto-Settle Proof Bypass
**Severity**: CRITICAL
**Category**: Smart Contract
**Commit**: `80f0fd5`

**Root cause**: In `ShieldedPool.sol:withdraw()`, the call to
`lendingPool.disburseLoan()` (auto-settle) was placed BEFORE
`require(proofVerified)`. Any caller could trigger the auto-settle
(clearing an active loan) without providing a valid ZK proof, simply
by passing garbage proof data.

**Impact**: An attacker could clear their outstanding loan for free by
calling `withdraw()` with a fabricated proof before paying back anything.

**Fix**: Moved `require(proofVerified)` to execute before the auto-settle
callback. The proof must be valid before any state change or ETH transfer
occurs.

---

### B-02 — Wrong Merkle Leaf Index in LeafInserted Event
**Severity**: HIGH
**Category**: Smart Contract
**Commit**: `80f0fd5`

**Root cause**: In `ShieldedPool.sol:_insertLeaf()`, the `LeafInserted`
event was emitted with `nextIndex + 1` (post-increment value) instead of
`nextIndex` (the actual position of the inserted leaf).

**Impact**: Every `LeafInserted` event reported a leaf index one higher than
the real position. The frontend built Merkle trees with all positions off
by one, making every withdrawal proof fail with "root mismatch" at the
MerkleTreeChecker constraint.

**Fix**: Changed event emission to `emit LeafInserted(leaf, nextIndex)`
before incrementing `nextIndex`.

---

### B-03 — `_dummiesForEpoch` Integer Underflow
**Severity**: HIGH
**Category**: Smart Contract
**Commit**: `80f0fd5`

**Root cause**: `uint8 depositsThisEpoch = depositCount[epoch]`. When
`depositsThisEpoch == 0`, a subsequent subtraction `depositsThisEpoch - 1`
underflowed to 255 (uint8 wraps), causing the function to return 10 dummies
for every single deposit — DoS-ing the epoch buffer.

**Impact**: After the underflow, each epoch inserted 10 dummies per deposit
rather than the adaptive count (2/5/10). Gas costs per `flushEpoch()` grew
proportionally. With many deposits, the epoch could run out of gas.

**Fix**: Added explicit guard: `if (depositsThisEpoch == 0) return 10;`
at the top of `_dummiesForEpoch()`.

---

### B-04 — Commitment Scheme Mismatch Across All Layers
**Severity**: CRITICAL
**Category**: Circuit + Frontend
**Commit**: `44e219e`

**Root cause**: Three different Poseidon formulas were used:

| Layer | Formula | Inputs |
|---|---|---|
| `withdraw_ring.circom` | `Poseidon(secret, nullifier)` | 2 |
| `collateral_ring.circom` | `Poseidon(secret, nullifier, denomination)` | 3 |
| `circuits.ts computeCommitment` (V1) | `Poseidon(nullifier, secret, amount)` | 3, wrong order |

A commitment computed by the frontend could never match what either circuit
expected. No deposited note could ever produce a valid proof.

**Impact**: The entire protocol was non-functional end-to-end. Every
withdrawal attempt would fail at the circuit constraint level regardless
of other correctness.

**Fix**: Unified commitment formula across frontend and withdraw circuit:
`Poseidon(secret, nullifier)` (2 inputs, matching `withdraw_ring.circom`).
Updated `circuits.ts:computeCommitment` accordingly. Collateral circuit
retains `Poseidon(secret, nullifier, denomination)` as it needs denomination
binding for the LTV check — these are treated as separate commitment types.

---

### B-05 — NullifierHash Formula Wrong
**Severity**: HIGH
**Category**: Frontend
**Commit**: `44e219e`

**Root cause**: `circuits.ts` computed `nullifierHash = Poseidon(nullifier)`
(1 input). The V2 circuit `withdraw_ring.circom` computes
`nullifierHash = Poseidon(nullifier, ring_index)` (2 inputs). These produce
different values.

**Impact**: The nullifierHash stored in the note (and used as the on-chain
spend tag) would never match the public signal emitted by the circuit.
The contract's `require(nullifierRegistry.isSpent(nullifierHash) == false)`
check would reference a hash that was never registered, breaking the
double-spend prevention mechanism.

**Fix**: Changed `computeCommitment` to use `Poseidon(nullifier, ringIndex)`
with `ringIndex = 0n` as the default (degenerate ring for testing). The
ring_index is baked into nullifierHash because that is what the circuit
emits as a public signal and what gets registered on-chain.

---

### B-06 — V1 Circuit Paths: Wrong wasm/zkey
**Severity**: CRITICAL
**Category**: Frontend
**Commit**: `44e219e`

**Root cause**: `circuits.ts` still pointed to V1 circuit files:
```
/circuits/withdraw.wasm      (depth-20 tree, V1 input structure)
/circuits/withdraw_final.zkey
```
The V2 contracts use a depth-24 Merkle tree. V2 circuits were compiled
during trusted setup but never copied to `frontend/public/circuits/`.

**Impact**: Every proof generation call would either fail with "file not
found" or, if V1 files existed, with "Too many values for input signal
pathElements" (24 path elements passed to a 20-level circuit).

**Fix**:
1. Copied `circuits/build/withdraw_ring_js/withdraw_ring.wasm` → `frontend/public/circuits/`
2. Copied `circuits/keys/withdraw_ring.zkey` → `frontend/public/circuits/`
3. Updated `CIRCUIT_PATHS.withdraw` to point to the new files

---

### B-07 — `generateWithdrawProof` V1 Input Structure
**Severity**: HIGH
**Category**: Frontend
**Commit**: `44e219e`

**Root cause**: `generateWithdrawProof` passed V1 inputs to snarkjs:
```typescript
// V1 — missing ring[], ring_index
{ nullifier, secret, pathElements, pathIndices, root, nullifierHash, recipient, amount }
```
The V2 circuit `withdraw_ring.circom` requires `ring[16]` and `ring_index`
as additional inputs.

**Impact**: snarkjs would throw "input signal ring not found" at witness
generation, failing every withdrawal before proof generation even starts.

**Fix**: Rewrote `generateWithdrawProof` with full V2 input structure.
Added `buildRing()` helper that constructs a degenerate ring:
`ring[0] = commitment`, `ring[1..15] = distinct non-zero dummies`,
`ring_index = 0`. Provides a valid proof with anonymity set of 1 for
testing. Production use requires real ring members from epoch flush events.

---

### B-08 — NoteKeyProvider Not Wired in App Tree
**Severity**: MEDIUM
**Category**: Frontend
**Commit**: `7f7033f`

**Root cause**: `NoteKeyContext` was implemented and exported but
`providers.tsx` never wrapped the app with `<NoteKeyProvider>`. Any
component calling `useNoteKey()` would get the default context value
(null key), silently bypassing encryption.

**Impact**: Notes were saved to localStorage unencrypted. The AES-256-GCM
encryption implementation was present but dead.

**Fix**: Added `<NoteKeyProvider>{children}</NoteKeyProvider>` wrapper
inside `QueryClientProvider` in `frontend/src/app/providers.tsx`.

---

### B-09 — DepositForm Calling `saveNote` Without Encryption Key
**Severity**: MEDIUM
**Category**: Frontend
**Commit**: `7f7033f`

**Root cause**: `DepositForm.tsx` called `saveNote(address, note, hash)`
with 3 arguments. The updated `saveNote` signature requires 4 arguments:
`saveNote(address, note, key, hash)`. The `key` (AES-256-GCM CryptoKey)
was omitted.

**Impact**: TypeScript type error at runtime. Notes either failed to save
or were saved without encryption depending on how `saveNote` handled the
missing argument.

**Fix**: Added `const { noteKey } = useNoteKey()` to DepositForm and
updated the call to `saveNote(address, pendingNote.current, noteKey, hash)`.
Also added `noteKey` to the `useEffect` dependency array.

---

### B-10 — Deposit Denomination: Free-Form Input + Wrong Allowed Set
**Severity**: MEDIUM
**Category**: Contract + UI
**Commit**: `eb7fb31`

**Root cause (contract)**: `ShieldedPool.deposit()` accepted only
`0.1 / 0.5 / 1.0 ETH`. A user depositing any other amount (e.g. `0.005`)
would get `InvalidDenomination` revert, surfaced as "exceeds max transaction
gas limit" (viem's error for a simulated call that reverts during estimation).

**Root cause (UI)**: `DepositForm` used a free-form `<input type="number">`
allowing any value — no client-side denomination validation. A user could
type `0.005` and only discover the error after MetaMask confirmation.

**Impact**: Every deposit with a non-matching denomination failed. Error
message ("exceeds max transaction gas limit") was confusing and gave no
indication of the real cause.

**Fix (contract)**: Expanded allowed denominations to 6 tiers:
`0.001 / 0.005 / 0.01 / 0.05 / 0.1 / 0.5 ETH`. Redeployed contracts
to Base Sepolia.

**Fix (UI)**: Replaced free-form input with a 3×2 grid of denomination
buttons. Invalid states are not representable in the UI — the button
set is the contract's allowed set.

**New contract addresses (Base Sepolia)**:
- ShieldedPool: `0xfaeD6bf64a513aCEC9E8f1672d5e6584F869661a`
- LendingPool: `0xdBc459EC670deE0ae70cbF8b9Ea43a00b7A9184D`
- NullifierRegistry: `0x685E69Fa36521f527C00E05cf3e18eE4d18aD10C`

---

### B-11 — LeafInserted vs Deposit Event Ambiguity
**Severity**: HIGH
**Category**: Frontend
**Commit**: `b90bd3d`

**Root cause**: Both `Deposit` and `LeafInserted` events have
`bytes32 indexed commitment` as `topics[1]`. `WithdrawForm.fetchMerklePath`
matched any log with `topics[1] == commitment` and `data.length >= 66`,
which always matched the `Deposit` event (emitted immediately at deposit
time) rather than the `LeafInserted` event (emitted only during `flushEpoch`).

The `Deposit` event's data encodes `(uint32 queuePosition, uint256 timestamp,
uint256 amount)`. The `queuePosition` is the note's position in the pending
queue before shuffling — not its final position in the Merkle tree. Using
it as the leaf index built a Merkle path from the wrong position, causing
MerkleTreeChecker assertion failures.

**Symptoms observed**: `Error: Assert Failed. Error in template
MerkleTreeChecker_76 line: 51 Error in template WithdrawRing_77 line: 182`

**Impact**: Every withdrawal attempt failed during witness generation even
when the epoch had been flushed and the commitment was genuinely in the tree.

**Fix**: Added `LEAF_INSERTED_TOPIC` constant:
```
keccak256("LeafInserted(bytes32,uint32)") =
0xa4e4458df45cfeb7eebc696f262212e6721fac69466bfc59f43b6040425afce6
```
Updated all log queries to filter `topics[0] === LEAF_INSERTED_TOPIC`
before checking `topics[1]`. Added a separate existence check using
`topics[1]` only (any event) to distinguish "deposit not found on-chain"
from "deposit found but not yet flushed."

---

### B-12 — Wrong `DEPLOY_BLOCK` Constant
**Severity**: HIGH
**Category**: Frontend
**Commit**: `b90bd3d`

**Root cause**: `WithdrawForm` had `const DEPLOY_BLOCK = 39499000n` —
the block number of the first V1 deployment. The V2 contracts were
deployed at block `39731476`.

**Impact**: `getAllLogs` fetched approximately 232,000 unnecessary blocks
of logs from the wrong contract era. With `CHUNK_SIZE = 9000`, this added
26 extra RPC calls per withdraw attempt, significantly slowing the UI and
potentially hitting RPC rate limits.

**Fix**: Updated `DEPLOY_BLOCK = 39731476n` to match the actual V2
deployment block (read from `contracts/broadcast/Deploy.s.sol/84532/run-latest.json`).

---

### B-13 — Epoch Not Flushed: No User Feedback, Withdraw Silently Broken
**Severity**: HIGH
**Category**: Frontend
**Commit**: `35b4f73`

**Root cause**: When a deposit had not yet been flushed into the Merkle
tree, `WithdrawForm` would find no `LeafInserted` event (after B-11 fix)
but show no explanation to the user — just a generic error or a confusing
MerkleTreeChecker assertion failure.

**Impact**: Users had no way to know their deposit was in a pending queue,
why withdrawal wasn't working, or when it would become available.

**Fix**:
1. Added `useEpochStatus()` hook (reads `lastEpochBlock` + `EPOCH_BLOCKS`
   from contract, refreshes every 12s).
2. Added `useBlockNumber({ watch: true })` for live block tracking.
3. `noteFlushStatus` state: `unknown → checking → pending | ready` set
   when a note is selected.
4. Amber countdown banner: shows blocks remaining and estimated seconds.
5. `DepositForm` success message updated to show the queue status and
   estimated time to Merkle insertion.

---

### B-14 — Manual Flush Required: Wrong UX for Approach A
**Severity**: MEDIUM
**Category**: Frontend
**Commit**: `2770e1c`

**Root cause**: The initial fix for B-13 added a separate "Flush Epoch"
button that users had to click before withdrawing. This is not Approach A
(described as: user waits 50 blocks, then clicks Withdraw once and the
system handles everything).

**Impact**: Users were confused by a technical internal mechanism
(`flushEpoch`) being exposed as a user action, and by having to click
a separate button before being able to withdraw.

**Fix**: Removed the manual "Flush Epoch" button entirely. The flush is
now triggered automatically inside `handleWithdraw` when:
- A `LeafInserted` event is not found for the note
- The epoch is confirmed ready (`blocksLeft === 0` from on-chain state)

If the epoch is not yet ready, `handleWithdraw` throws a clear message
with blocks/seconds remaining. The Withdraw button is disabled while
`noteFlushStatus === "pending"` AND blocks remain. When ready, the button
is enabled and the flush happens transparently on Withdraw click.

**Button label progression for user**:
`Withdraw` → MetaMask (flush) → `Inserting into Merkle tree...` →
`Fetching Merkle path...` → MetaMask (withdraw) → Done.

---

### B-15 — Race Condition: `getAllLogs` Runs Before Flush Block Indexed
**Severity**: HIGH
**Category**: Frontend
**Commit**: `607ac0a`

**Root cause**: `writeContractAsync({ functionName: "flushEpoch" })` returns
the transaction hash as soon as the transaction is **broadcast and accepted
into the mempool**, not when it is mined and indexed. The next line
immediately called `getAllLogs(publicClient, address)` which internally
called `publicClient.getBlockNumber()` — returning a block number that
predated the flush transaction's inclusion block.

**Symptoms observed**: "Flush succeeded but LeafInserted event not found.
Try withdrawing again." — the flush transaction confirmed (seen in MetaMask
as successful), but the LeafInserted log query missed it.

**Secondary symptom**: After the error, the `noteFlushStatus` background
effect re-ran, also missing the event. `lastEpochBlock` had been reset
by the flush to the current block, so `blocksLeft ≈ 50` — a fresh
50-block countdown appeared as if the flush never happened.

**Fix**:
```typescript
const flushTxHash = await writeContractAsync({ functionName: "flushEpoch" });
const flushReceipt = await publicClient.waitForTransactionReceipt({ hash: flushTxHash });
// Now pass flushReceipt.blockNumber as upToBlock — guaranteed to include the flush
const freshLogs = await getAllLogs(publicClient, address, flushReceipt.blockNumber);
```
Updated `getAllLogs` signature to accept optional `upToBlock?: bigint`.

---

### B-16 — Race Condition: `noteFlushStatus` Background Effect
**Severity**: HIGH
**Category**: Frontend
**Commit**: `7efb2ad`

**Root cause**: Same race condition as B-15 but in the `useEffect` that
checks note status when a note is selected in the dropdown. The effect
called `getAllLogs(publicClient, address)` without pinning the block number.
If triggered by a re-render immediately after a flush, it could query a
stale block range and incorrectly report the note as still pending.

**Impact**: Even after B-15 was fixed (handleWithdraw correctly found the
LeafInserted log and set `noteFlushStatus("ready")`), a concurrent re-render
could trigger the background effect, which would overwrite `noteFlushStatus`
back to `"pending"` — re-showing the amber countdown banner with a fresh
50-block wait.

**Fix**: Snapshot block number before calling getAllLogs inside the effect:
```typescript
publicClient.getBlockNumber()
  .then(snapshotBlock => getAllLogs(publicClient, address, snapshotBlock))
  .then(logs => { ... })
```
The snapshot is taken atomically before the query, ensuring the block range
used for the check is consistent.

---

### B-17 — Note Label Collision
**Severity**: LOW
**Category**: Frontend
**Commit**: `9a9032e`

**Root cause**: `noteLabel()` in `noteStorage.ts` formatted labels as
`"0.0050 ETH · 03/04/2026"` using only date, no time. Two deposits of the
same denomination on the same day produced identical dropdown entries in
`WithdrawForm`.

**Impact**: Users could not distinguish which note was which if they made
multiple same-denomination deposits in a single day. Risk of selecting
the wrong note for withdrawal.

**Fix**: Updated format to `"0.0050 ETH · 03/04/2026 14:32 · #a3f7"`:
- Added `HH:MM` local time — distinguishes same-day deposits
- Added last 4 hex characters of the commitment — distinguishes same-minute
  deposits and allows users to cross-reference with their note backup
- The commitment suffix reveals no private data (commitment is already
  a public on-chain value)

---

### B-18 — Dead ptau Download URL in `trusted_setup.sh`
**Severity**: LOW
**Category**: Tooling
**Commit**: `f81f7f1`

**Root cause**: The Hermez S3 bucket URL
`https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_17.ptau`
was decommissioned. Downloading it returned an HTML error page (243 bytes),
which snarkjs then rejected as "invalid ptau file format."

**Fix**: Updated URL to the iden3 zkEVM Google Cloud Storage bucket:
`https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau`

---

### B-19 — VK Hash Computation Broken
**Severity**: LOW
**Category**: Tooling
**Commit**: `f81f7f1`

**Root cause**: Two issues in the inline Node.js heredoc inside
`trusted_setup.sh`:

1. `__dirname` is not defined when Node.js runs a script via `node -`
   (stdin). The `path.join(__dirname, "keys")` call threw
   `ReferenceError: __dirname is not defined`.

2. `crypto.createHash("keccak256")` is not supported in Node.js built-in
   `crypto`. Threw `Digest method not supported`.

**Fix**:
1. Changed `__dirname` → `process.cwd()` for path resolution.
2. Changed keccak256 computation to use `ethers.keccak256()` from the
   already-installed `ethers` package.

---

### B-20 — `foundry.toml` Missing from `contracts/`
**Severity**: LOW
**Category**: Tooling
**Commit**: `f81f7f1`

**Root cause**: The `contracts/` directory had no `foundry.toml`. Forge
requires this file to locate source directories, compiler version, and
RPC endpoints.

**Impact**: `forge build` and `forge script` failed with configuration
errors when run from the `contracts/` directory.

**Fix**: Created `contracts/foundry.toml` with:
```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"

[rpc_endpoints]
base_sepolia = "${BASE_SEPOLIA_RPC_URL}"
anvil = "http://127.0.0.1:8545"

[etherscan]
base_sepolia = { key = "${ETHERSCAN_API_KEY}", url = "https://api-sepolia.basescan.org/api" }
```

---

## Open Security Issues (Not Yet Fixed)

These are carried over from `AUDIT_REPORT.md`. They are known vulnerabilities
that must be fixed before any real funds are exposed. The testnet deployment
should not receive real ETH until at minimum the CRITICAL items are resolved.

| ID | Severity | Title |
|---|---|---|
| C-1 | CRITICAL | `LendingPool.borrow()` has no access control |
| C-2 | CRITICAL | `LendingPool.liquidate()` never unlocks collateral |
| C-3 | CRITICAL | `NullifierRegistry.setShieldedPool()` owner can rug |
| H-1 | HIGH | Withdraw amount not validated against denomination |
| H-2 | HIGH | `disburseLoan()` has no maximum amount cap |
| H-3 | HIGH | Ring-index-dependent nullifier enables double-spend |
| M-1 | MEDIUM | Repaid ETH trapped in LendingPool |
| M-2 | MEDIUM | Interest accrual uses block.timestamp |
| M-3 | MEDIUM | No slippage/deadline on borrow |
| M-4 | MEDIUM | Re-entrancy window in `ShieldedPool.withdraw()` |
| M-5 | MEDIUM | `_dummiesForEpoch` reads block.number at proof time |
| M-6 | MEDIUM | Aggregation root staleness — no max age check |
| M-7 | MEDIUM | `NullifierRegistry.setShieldedPool()` no timelock |
| L-1 | LOW | ring[] public input leaks ring composition |
| L-2 | LOW | relayer/fee public inputs never validated on-chain |
| L-3 | LOW | GreaterEqThan(96) LTV check truncates |
| L-4 | LOW | NoteKeyContext key not zeroized on unmount |

Full details for each: see `AUDIT_REPORT.md`.

---

## Key Learnings for Documentation

### Why deposits are not immediately withdrawable

The 50-block epoch wait is a **privacy mechanism, not a bug**. Deposits
accumulate in `pendingCommitments[]` during the epoch window. When
`flushEpoch()` is called, all pending deposits are shuffled using
`block.prevrandao` and inserted into the Merkle tree together with dummy
commitments. This breaks timing correlation between deposit and withdrawal.

The 50-block period (~100 seconds on Base Sepolia) is the minimum time for
other users' deposits to accumulate in the same batch. The larger the batch,
the stronger the privacy guarantee.

### Why two MetaMask confirmations on withdraw

When a deposit's epoch is ready but not yet flushed:
1. **First confirmation**: `flushEpoch()` — inserts the commitment into the
   Merkle tree. This is a permissionless call anyone can make; the user
   calling it does not reveal which commitment is theirs (the flush batch
   may contain multiple deposits).
2. **Second confirmation**: `withdraw()` — the actual ZK proof submission.

This is Approach A and is acceptable for a POC/demo. Production would use
a keeper service (funded by the 0.1% protocol fee) so users never see the
flush step at all.

### Why the ring anonymity set is 1 in testing

`withdraw_ring.circom` is designed for rings of K=16 commitments. In testing,
`buildRing()` in `circuits.ts` uses a degenerate ring: `ring[0]` = the
prover's commitment, `ring[1..15]` = dummy values. The circuit proves
membership but the anonymity set is trivially 1 — an observer can see
the ring and identify the real commitment.

Real privacy requires the ring to be populated with 15 other real
commitments from the same epoch flush. The frontend infrastructure for
deriving the ring from `EpochFlushed` + `LeafInserted` events is the
next engineering milestone.

---

*Report generated: 2026-04-03. For the full security audit with detailed
impact analysis and fix recommendations, see `AUDIT_REPORT.md`.*
