# ShieldLend — Project Roadmap

This document describes the full implementation sequence for ShieldLend. Steps are ordered by dependency — each step's output is a prerequisite for the next. Estimated effort is in engineering days assuming focused work.

---

## Current Status

| Step | Status |
|------|--------|
| Design & architecture | ✅ Complete |
| Competitive analysis | ✅ Complete |
| Circuit specification | ✅ Complete |
| Contract interface specification | ✅ Complete |
| Step 1 — Scaffold | 🔜 Next |
| Steps 2–10 | ⏳ Pending |

---

## Implementation Steps

### Step 1 — Project Scaffold (~1 day)

**What**: Initialize the full project structure with all tooling configured.

**Tasks**:
- `forge init` — Foundry project for Solidity contracts
- Circom project structure — `circuits/`, `build/`, `keys/` directories
- Next.js frontend scaffold with wagmi wallet connection
- `package.json` with snarkjs, wagmi, viem, ethers dependencies
- `.gitignore` covering `build/`, `keys/`, `.env*`, `node_modules/`

**Done when**: `forge build` succeeds (no contracts yet), `npm run dev` starts the frontend, `circom --version` confirms Circom installed.

---

### Step 2 — `deposit.circom` (~2–3 days)

**What**: Write and test the deposit circuit. This is the foundation — all other circuits reference the commitment format it defines.

**Tasks**:
- Import `circomlib` — `pedersen.circom`, `mimcsponge.circom`, `poseidon.circom`
- Define private signals: `amount`, `secret`, `nullifier`
- Define public output: `commitment = Pedersen(amount || secret)`
- Define public output: `nullifierHash = Poseidon(nullifier)`
- Write constraints for commitment and nullifier hash derivation
- Compile: `circom deposit.circom --r1cs --wasm --sym`
- Run trusted setup: `snarkjs groth16 setup deposit.r1cs pot12_final.ptau deposit_0000.zkey`
- Generate test proof: `snarkjs groth16 prove deposit_0000.zkey witness.wtns proof.json public.json`
- Verify: `snarkjs groth16 verify vkey.json public.json proof.json`

**Done when**: Circuit compiles, proof generates and verifies for a known (amount, secret, nullifier) triple.

---

### Step 3 — `withdraw.circom` (~3–4 days)

**What**: Write and test the withdrawal circuit. This is the most complex circuit — it proves Merkle membership and nullifier knowledge simultaneously.

**Tasks**:
- Import `MerkleTreeChecker` from circomlib (or implement incremental Merkle tree checker)
- Private signals: `secret`, `nullifier`, `pathElements[levels]`, `pathIndices[levels]`
- Public signals: `root` (current Merkle root), `recipient` (withdrawal address)
- Public output: `nullifierHash`
- Constraints:
  - Recompute `commitment = Pedersen(amount || secret)` (matches the deposit)
  - Verify `commitment` is a leaf in the Merkle tree with the given path → output equals `root`
  - Verify `nullifierHash = Poseidon(nullifier)`
- Compile, trusted setup, generate test proof, verify

**Done when**: Circuit correctly accepts a valid (secret, path, root) triple and rejects an invalid path.

---

### Step 4 — Trusted Setup (~1 day)

**What**: Run the Powers of Tau ceremony and generate per-circuit proving keys.

**Tasks**:
- Download an existing Powers of Tau file (Hermez ceremony, `pot12_final.ptau` for circuits up to 2^12 constraints)
- For each circuit: `snarkjs groth16 setup <circuit>.r1cs pot12_final.ptau <circuit>_0000.zkey`
- Export verification keys: `snarkjs zkey export verificationkey <circuit>_0000.zkey vkey.json`
- Export Solidity verifiers: `snarkjs zkey export solidityverifier <circuit>_0000.zkey <Circuit>Verifier.sol`
- Store `.zkey` files in `keys/` (gitignored — large binary files)

**Note**: For production, a proper multi-party ceremony should be run. For testnet MVP, a single-party setup is acceptable with a clear disclaimer.

**Done when**: All three circuits have `.zkey` files, `vkey.json` exports, and Solidity verifier contracts generated.

---

### Step 5 — Deploy `ShieldedPool.sol` + `NullifierRegistry.sol` (~1–2 days)

**What**: Write and deploy the two core contracts.

**Tasks**:

`NullifierRegistry.sol`:
- `mapping(bytes32 => bool) public nullifiers`
- `function isSpent(bytes32 nullifierHash) external view returns (bool)`
- `function markSpent(bytes32 nullifierHash) external` — onlyShieldedPool modifier

`ShieldedPool.sol`:
- Incremental Merkle tree (20 levels → 2^20 = 1M leaves)
- `function deposit(bytes32 commitment) external payable` — inserts commitment, emits event
- `function withdraw(bytes calldata proof, bytes32 nullifierHash, bytes32 root, address payable recipient) external`
  - Verifies zkVerify attestation
  - Checks nullifier not spent
  - Marks nullifier spent
  - Releases funds to recipient
- `function getRoot() external view returns (bytes32)`
- `function isKnownRoot(bytes32 root) external view returns (bool)` — supports historical roots

Deploy on Horizen L3 testnet (fallback: Base Sepolia):
```bash
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

**Done when**: Contracts deployed, `deposit()` transaction succeeds on testnet, Merkle root updates.

---

### Step 6 — zkVerify Integration (~2–3 days)

**What**: Wire the proof submission pipeline. Instead of verifying proofs on-chain (expensive), proofs are submitted to zkVerify, which emits an attestation that the ShieldedPool contract accepts.

**Tasks**:
- Install zkVerifyJS SDK: `npm install zkverifyjs`
- Initialize client: `const zkv = await ZkVerifySession.start().Testnet().withWallet(wallet)`
- Submit proof: `await zkv.verify().groth16(vkeyJson).execute({ proofData: { proof, publicSignals, vk } })`
- Listen for attestation event
- Attestation ID passed to `ShieldedPool.withdraw()` as proof of verification
- Write relayer script: watches zkVerify attestation events, calls withdraw on ShieldedPool

**Done when**: A real proof submitted to zkVerify testnet returns a valid attestation ID. ShieldedPool accepts the attestation and releases funds.

---

### Step 7 — Frontend: Wallet + Browser Proofs (~3–4 days)

**What**: Build the user-facing interface. The key design constraint: all proof generation happens in the browser using snarkjs WASM — no server ever sees the user's secret.

**Tasks**:
- wagmi wallet connection (MetaMask → Horizen L3 / Base Sepolia)
- Deposit page:
  - Input: amount
  - Generate: `secret = random bytes`, `nullifier = random bytes`
  - Compute: `commitment = Pedersen(amount, secret)` (using snarkjs WASM)
  - Download: encrypted note file `{ amount, secret, nullifier, commitment, leafIndex }`
  - Submit: `ShieldedPool.deposit(commitment, { value: amount })`
- Withdraw page:
  - Input: note file upload
  - Fetch: current Merkle root + path from contract events
  - Generate: Groth16 proof via `snarkjs.groth16.fullProve()`
  - Submit: proof to zkVerify, then withdrawal transaction
- Loading states, error handling, note backup warning

**Done when**: Full deposit → note saved → withdraw flow works end-to-end in browser on testnet.

---

### Step 8 — `LendingPool.sol` (Aave V3 Fork) (~3–4 days)

**What**: Add borrow and repay mechanics on top of the shielded pool. This is a minimal fork of Aave V3 core — only the parts needed for collateral-backed borrowing.

**Tasks**:
- Fork minimal Aave V3 pool: `supply()`, `borrow()`, `repay()`, `liquidate()`
- Integrate with ShieldedPool: deposits into ShieldedPool count as collateral
- `borrow()` takes a collateral range proof instead of requiring public position disclosure
- Interest rate model (simplified fixed rate for MVP)
- Liquidation mechanic (requires some public position exposure — see architecture docs)

**Done when**: A user can deposit to the shielded pool, prove sufficient collateral, borrow, and repay — all without revealing their exact position.

---

### Step 9 — `collateral.circom` (~2–3 days)

**What**: Write the collateral range proof circuit. Proves `collateral ≥ min_ratio × borrowed` without revealing the exact collateral amount.

**Tasks**:
- Private signal: `exact_collateral`
- Public signals: `min_ratio` (e.g., 150 for 150%), `borrowed_amount`
- Constraint: `exact_collateral * 100 >= min_ratio * borrowed_amount`
- Range check: ensure `exact_collateral` is a valid positive integer (no underflow)
- Compile, trusted setup, test proof

**Done when**: Circuit correctly allows valid collateral ratios and rejects undercollateralized positions.

---

### Step 10 — End-to-End Tests + Testnet Deploy (~2–3 days)

**What**: Full integration test suite and deployed demo.

**Tasks**:
- Foundry tests: deposit → withdraw flow, nullifier double-spend prevention, Merkle root history
- zkVerify integration test: real proof submission, real attestation
- Frontend E2E: full user flow in browser
- Deploy all contracts to Horizen L3 testnet
- Deploy frontend to Vercel (or IPFS)
- Record demo video: private deposit → borrow → repay → private withdraw

**Done when**: All tests pass. Contracts live on testnet. Demo video recorded. Repo README updated with testnet contract addresses.

---

## Total Estimated Effort

| Steps | Effort |
|-------|--------|
| Steps 1–4 (circuits + setup) | ~7–9 days |
| Steps 5–6 (contracts + zkVerify) | ~3–5 days |
| Steps 7–9 (frontend + lending) | ~8–11 days |
| Step 10 (testing + deploy) | ~2–3 days |
| **Total** | **~20–28 days** |

This is a two-person engineering effort working in parallel on circuits/contracts and frontend.
