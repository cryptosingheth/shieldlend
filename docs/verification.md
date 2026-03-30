# Proof verification — technical guide

This document explains **how proofs are verified** in ShieldLend, which **artifacts and contracts** are involved, and how to **regenerate proofs** for Foundry tests after changing circuits or keys.

---

## Two verification paths

| Path | Where it runs | Used for |
|------|----------------|----------|
| **zkVerify aggregation** | `ShieldedPool` calls `IZkVerifyAggregation.verifyProofAggregation` | Production withdrawals: cheap gas; proof checked off-chain on zkVerify, then a Merkle inclusion proof is checked on-chain. |
| **Groth16 Solidity verifier** | `DepositVerifier`, `WithdrawVerifier`, `CollateralVerifier` (`verifyProof`) | Optional on-chain Groth16 check; `LendingPool` uses `CollateralVerifier` for borrow proofs; full-path tests live in Foundry. |

These are **independent**: the Solidity verifier embeds a **verification key** derived from your circuit’s `.zkey`. zkVerify uses its own pipeline and **statement hashes** bound to the same public inputs. If you change the trusted setup or circuit, you must refresh **both** the exported Solidity verifiers **and** any zkVerify-facing keys your app uses.

---

## Groth16 on-chain verification (how `verifyProof` works)

1. **Public inputs** — Field elements (≤ BN254 scalar field order `r`) passed as `uint256` arrays. Their **order** must match snarkjs / Circom (outputs first, then `public` inputs in declaration order).

2. **Proof tuple** — Groth16 proof `(π_A ∈ G1, π_B ∈ G2, π_C ∈ G1)` encoded as:
   - `pA[2]`, `pC[2]`: affine Fq coordinates for G1 points  
   - `pB[2][2]`: G2 point (two Fq² limbs per coordinate)

3. **Verifier contract** — SnarkJS-generated Solidity builds a linear combination of fixed **IC** points with the public inputs, then runs a **single pairing check** on BN128 via precompile `0x08` (`ecPairing`). Internally it uses `0x06` (G1 add), `0x07` (G1 mul) for the MSM step.

4. **Result** — `verifyProof` returns `true` iff the pairing equation holds for the proof and public signals under the embedded vk. Tampering with any public signal or proof coordinate without a fresh valid proof makes the check fail.

---

## Files involved in local proof generation and tests

| Path | Role |
|------|------|
| `scripts/gen_test_proofs.js` | Node script: runs `snarkjs.groth16.fullProve` for `deposit`, `collateral`, and `withdraw`; writes `circuits/build/test_proofs.json` and prints Solidity-style calldata. **Requires** compiled WASM + `*_final.zkey` + `*_vkey.json` under `circuits/build/`. |
| `contracts/test/Groth16Verifiers.t.sol` | Foundry tests that deploy the three verifier contracts and call `verifyProof` with **real** curve points (valid proofs + tampered / dummy cases). Values are synced with the last `gen_test_proofs.js` run for the **same** zkeys as the Solidity verifiers. |
| `contracts/src/verifiers/DepositVerifier.sol` | SnarkJS-exported Groth16 verifier for `deposit.circom`. |
| `contracts/src/verifiers/WithdrawVerifier.sol` | SnarkJS-exported Groth16 verifier for `withdraw.circom`. |
| `contracts/src/verifiers/CollateralVerifier.sol` | SnarkJS-exported Groth16 verifier for `collateral.circom`. |
| `circuits/build/*.r1cs`, `*_js/*.wasm` | Circuit compile outputs from `circom`. |
| `circuits/build/*_final.zkey` | Final proving key after Groth16 setup + contribution (or beacon). Must match the verifier you deploy. |
| `circuits/build/*_vkey.json` | Verification key JSON (snarkjs `groth16 verify`, frontends). |
| `circuits/build/test_proofs.json` | Generated proof bundle + calldata strings (optional reference; tests hardcode values for stability in CI without requiring Node). |
| `circuits/build/pot13.ptau` | Powers-of-tau file used in this repo’s dev pipeline (Hermez `powersOfTau28_hez_final_13.ptau` or equivalent). |

---

## End-to-end: compile → keys → verifiers → proofs → Forge

Run from the **repository root** unless noted.

### 1. Dependencies

- **Node**: `npm install` at repo root (provides `snarkjs`, `circomlibjs`).
- **Circom**: on `PATH` (e.g. `cargo install` from [iden3/circom](https://github.com/iden3/circom)).

### 2. Compile circuits

```bash
mkdir -p circuits/build
circom circuits/deposit.circom    --r1cs --wasm --sym -o circuits/build -l node_modules
circom circuits/withdraw.circom   --r1cs --wasm --sym -o circuits/build -l node_modules
circom circuits/collateral.circom --r1cs --wasm --sym -o circuits/build -l node_modules
```

Outputs land in `circuits/build/` (e.g. `deposit_js/deposit.wasm`, `deposit.r1cs`).

### 3. Powers of tau and Groth16 setup

Use a ptau with **sufficient power** for your constraint count (here `2^13` is enough for these circuits):

```bash
# Example: download once
curl -sL https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_13.ptau \
  -o circuits/build/pot13.ptau

npx snarkjs groth16 setup circuits/build/deposit.r1cs    circuits/build/pot13.ptau circuits/build/deposit_0000.zkey
npx snarkjs groth16 setup circuits/build/withdraw.r1cs   circuits/build/pot13.ptau circuits/build/withdraw_0000.zkey
npx snarkjs groth16 setup circuits/build/collateral.r1cs circuits/build/pot13.ptau circuits/build/collateral_0000.zkey
```

Finalize each zkey (contributions or beacon — dev example):

```bash
npx snarkjs zkey beacon circuits/build/deposit_0000.zkey    circuits/build/deposit_final.zkey    <beaconHex> 10
npx snarkjs zkey beacon circuits/build/withdraw_0000.zkey   circuits/build/withdraw_final.zkey   <beaconHex> 10
npx snarkjs zkey beacon circuits/build/collateral_0000.zkey circuits/build/collateral_final.zkey <beaconHex> 10
```

Export vkeys:

```bash
npx snarkjs zkey export verificationkey circuits/build/deposit_final.zkey    circuits/build/deposit_vkey.json
npx snarkjs zkey export verificationkey circuits/build/withdraw_final.zkey   circuits/build/withdraw_vkey.json
npx snarkjs zkey export verificationkey circuits/build/collateral_final.zkey circuits/build/collateral_vkey.json
```

### 4. Export Solidity verifiers (must match zkeys)

```bash
npx snarkjs zkey export solidityverifier circuits/build/deposit_final.zkey    contracts/src/verifiers/DepositVerifier.sol
npx snarkjs zkey export solidityverifier circuits/build/withdraw_final.zkey   contracts/src/verifiers/WithdrawVerifier.sol
npx snarkjs zkey export solidityverifier circuits/build/collateral_final.zkey contracts/src/verifiers/CollateralVerifier.sol
```

SnarkJS emits `contract Groth16Verifier` — rename each contract to `DepositVerifier`, `WithdrawVerifier`, and `CollateralVerifier` respectively (same as existing repo convention).

### 5. Generate test proofs and JSON

```bash
node scripts/gen_test_proofs.js
```

This:

- Proves **deposit** with fixed test witnesses (`nullifier=123`, `secret=456`, `amount=1000`).
- Proves **collateral** with `collateral=2000`, `borrowed=1000`, `ratio=15000`.
- Builds a **20-level** Merkle root consistent with `ShieldedPool`’s Poseidon binary tree (zeros on the right path) and proves **withdraw** for the same note.

Writes `circuits/build/test_proofs.json`. **If you change zkeys or witnesses**, copy the new `pA/pB/pC` and public signal arrays from the script output (or JSON) into `Groth16Verifiers.t.sol`.

### 6. Verify with snarkjs (off-chain sanity check)

After `groth16 prove` or `fullProve`, you have `public.json` and `proof.json`:

```bash
npx snarkjs groth16 verify circuits/build/deposit_vkey.json public.json proof.json
```

`gen_test_proofs.js` already checks each proof with `snarkjs.groth16.verify` before writing `test_proofs.json`; use the CLI when debugging a single circuit export.

### 7. Verify with Foundry (on-chain verifier bytecode)

```bash
forge test --match-contract Groth16VerifiersTest -vv
forge test
```

The tests exercise **valid** Groth16 proofs and **invalid** cases (wrong public inputs, garbage points) against the deployed verifier contracts.

---

## zkVerify path (ShieldedPool withdrawals) — short reference

1. User produces a Groth16 proof + public signals in the browser (same circuit math).
2. Proof is submitted to zkVerify; after aggregation, the app obtains `domainId`, `aggregationId`, Merkle path, `leafCount`, `leafIndex`.
3. `ShieldedPool` recomputes the **statement leaf** from public inputs (`PROVING_SYSTEM_ID`, `vkHash`, `VERSION_HASH`, endian-adjusted public input hash) and calls `verifyProofAggregation`.

Details and leaf encoding align with [zkVerify’s Groth16 / Circom docs](https://docs.zkverify.io/overview/getting-started/smart-contract). The `vkHash` in `ShieldedPool` must match the key material zkVerify uses for your circuit.

---

## Checklist after changing a `.circom` file

1. Recompile the circuit (`circom …`).
2. Re-run `groth16 setup` → finalize zkey → export `*_vkey.json` and Solidity verifier for **that** circuit.
3. Run `node scripts/gen_test_proofs.js` and update `Groth16Verifiers.t.sol` if hardcoded constants drift.
4. `forge test`.
5. Redeploy verifiers / pool as needed; refresh zkVerify registration if you use attestation.

---

## Related docs

- [circuits.md](./circuits.md) — circuit semantics and the older `circuits/keys/` oriented setup notes.
- [architecture.md](./architecture.md) — system-level flow.
