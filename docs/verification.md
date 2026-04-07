# ShieldLend V2A — Proof Verification Guide

This document explains how proofs are verified in ShieldLend V2A, what artifacts are involved, and how to regenerate keys after circuit changes.

---

## Two Verification Paths

| Path | Where | Used For |
|---|---|---|
| zkVerify aggregation | ShieldedPool calls ZkVerifyAggregation.verifyProofAggregation | Production withdrawals and borrows. Proof checked off-chain on zkVerify Volta; aggRoot checked on-chain via single-leaf Merkle. |
| Groth16 Solidity verifier | CollateralVerifier.verifyProof | On-chain Groth16 fallback; used in Foundry tests. |

These are independent. The Solidity verifier embeds a verification key from the circuit's .zkey. zkVerify uses its own pipeline with statementHash-encoded public inputs. If you change the circuit, you must refresh both the Solidity verifier AND the zkVerify vkey registration.

---

## zkVerify Verification — How It Works (V2A)

### 1. Proof submission

```typescript
// /api/zkverify route (server-side, Next.js)
const session = await ZkVerifySession.start().Volta().withAccount(DEPLOYER_SEED);
const { domainId, aggregationId } = await session
    .verify()
    .groth16(collateral_ring_vkey_json)  // or withdraw_ring_vkey
    .execute({ proof, publicSignals });
```

### 2. Aggregation root computation and posting

```typescript
// /api/withdraw or /api/borrow route
const leaf = await publicClient.readContract({
    address: SHIELDED_POOL_ADDRESS,
    functionName: "statementHash",
    args: [[root, nullifierHash, BigInt(recipient), amount]]
});
const aggRoot = keccak256(encodePacked(["bytes32"], [leaf]));
await writeContract({ functionName: "submitAggregation",
    args: [domainId, aggregationId, aggRoot] });
```

### 3. On-chain verification in ShieldedPool.withdraw()

```solidity
function _verifyAttestation(
    uint256 domainId, uint256 aggregationId, bytes32 aggRoot,
    bytes32[] memory merklePath, uint256 leafCount, uint256 leafIndex,
    bytes32 leaf
) internal view {
    bool ok = zkVerifyAgg.verifyProofAggregation(
        domainId, aggregationId, aggRoot, merklePath, leafCount, leafIndex, leaf
    );
    require(ok, "InvalidProof");
}
```

### 4. What Merkle.verifyProofKeccak checks for single-leaf

For `merklePath=[], leafCount=1, leafIndex=0`:
```
verifyProofKeccak(aggRoot, [], 1, 0, leaf)
  -> assert keccak256(leaf) == aggRoot
```
A 1-leaf Merkle tree has root = keccak256(leaf). This is the V2A single-leaf aggregation pattern.

### Critical: required env vars

Without these, submitAggregation is silently skipped and aggRoot stays bytes32(0). verifyProofAggregation always returns false. Surface symptom: "exceeds max transaction gas limit: 140M" in the frontend.

```
DEPLOYER_PRIVATE_KEY=0x...  (in frontend/.env.local — gitignored)
ZKVERIFY_AGGREGATION_ADDRESS=0x8b722840538d9101bfd8c1c228fb704fbe47f460
```

---

## Groth16 On-Chain Verification — How verifyProof Works

1. Public inputs — field elements (< BN254 scalar field order r) as uint256 arrays. Order must match snarkjs/Circom (outputs first, then public inputs in declaration order).

2. Proof tuple — Groth16 proof (pA in G1, pB in G2, pC in G1) encoded as:
   - pA[2], pC[2]: affine Fq coordinates for G1 points
   - pB[2][2]: G2 point (two Fq² limbs per coordinate)

3. Verifier contract — snarkjs-generated Solidity builds a linear combination of fixed IC points with public inputs, then runs a pairing check on BN128 via precompile 0x08 (ecPairing).

4. Result — verifyProof returns true iff the pairing equation holds. Tampering with any public signal or proof point breaks the check.

---

## Files Involved in V2A

| Path | Role |
|---|---|
| circuits/withdraw_ring.circom | V2A withdrawal circuit. K=16 ring, LEVELS=24. |
| circuits/collateral_ring.circom | V2A collateral circuit. Ring + LTV check. |
| circuits/build/withdraw_ring_js/withdraw_ring.wasm | Compiled WASM for browser proving |
| circuits/build/collateral_ring_js/collateral_ring.wasm | Compiled WASM for browser proving |
| circuits/keys/withdraw_ring_final.zkey | Proving key (large binary, gitignored) |
| circuits/keys/collateral_ring_final.zkey | Proving key (large binary, gitignored) |
| circuits/keys/withdraw_ring_vkey.json | Verification key JSON (small, committed) |
| circuits/keys/collateral_ring_vkey.json | Verification key JSON (small, committed) |
| frontend/public/circuits/withdraw_ring.wasm | WASM served to browser |
| frontend/public/circuits/withdraw_ring.zkey | zkey served to browser |
| frontend/public/circuits/collateral_ring.wasm | WASM served to browser |
| frontend/public/circuits/collateral_ring.zkey | zkey served to browser |
| contracts/src/verifiers/CollateralVerifier.sol | snarkjs-exported Groth16 verifier |
| contracts/src/verifiers/WithdrawVerifier.sol | snarkjs-exported Groth16 verifier |

---

## End-to-End: Compile -> Keys -> Verifiers -> Test

### 1. Dependencies

```bash
npm install         # at repo root — provides snarkjs, circomlibjs
# circom on PATH:   cargo install --git https://github.com/iden3/circom
# forge:            https://book.getfoundry.sh/
```

### 2. Compile circuits

```bash
mkdir -p circuits/build
circom circuits/withdraw_ring.circom   --r1cs --wasm --sym -o circuits/build -l node_modules
circom circuits/collateral_ring.circom --r1cs --wasm --sym -o circuits/build -l node_modules
```

Outputs: circuits/build/withdraw_ring_js/withdraw_ring.wasm, circuits/build/withdraw_ring.r1cs

### 3. Powers of Tau and Groth16 setup

```bash
# Download ptau (iden3 GCS — Hermez S3 bucket is decommissioned)
curl -sL https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau \
     -o circuits/build/pot17.ptau

npx snarkjs groth16 setup circuits/build/withdraw_ring.r1cs \
    circuits/build/pot17.ptau circuits/build/withdraw_ring_0000.zkey
npx snarkjs groth16 setup circuits/build/collateral_ring.r1cs \
    circuits/build/pot17.ptau circuits/build/collateral_ring_0000.zkey

# Finalize with beacon (dev) or contribution (production)
npx snarkjs zkey beacon circuits/build/withdraw_ring_0000.zkey \
    circuits/build/withdraw_ring_final.zkey <beaconHex> 10
npx snarkjs zkey beacon circuits/build/collateral_ring_0000.zkey \
    circuits/build/collateral_ring_final.zkey <beaconHex> 10
```

### 4. Export verification keys and Solidity verifiers

```bash
npx snarkjs zkey export verificationkey circuits/build/withdraw_ring_final.zkey \
    circuits/keys/withdraw_ring_vkey.json
npx snarkjs zkey export verificationkey circuits/build/collateral_ring_final.zkey \
    circuits/keys/collateral_ring_vkey.json

npx snarkjs zkey export solidityverifier circuits/build/withdraw_ring_final.zkey \
    contracts/src/verifiers/WithdrawVerifier.sol
npx snarkjs zkey export solidityverifier circuits/build/collateral_ring_final.zkey \
    contracts/src/verifiers/CollateralVerifier.sol
```

snarkjs emits contract Groth16Verifier — rename each to WithdrawVerifier and CollateralVerifier.

### 5. Copy WASM + zkey to frontend/public

```bash
cp circuits/build/withdraw_ring_js/withdraw_ring.wasm frontend/public/circuits/
cp circuits/build/withdraw_ring_final.zkey frontend/public/circuits/withdraw_ring.zkey
cp circuits/build/collateral_ring_js/collateral_ring.wasm frontend/public/circuits/
cp circuits/build/collateral_ring_final.zkey frontend/public/circuits/collateral_ring.zkey
```

### 6. Compute VK hash for ShieldedPool.sol

```bash
node -e "
const ethers = require('ethers');
const vkey = require('./circuits/keys/withdraw_ring_vkey.json');
const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(vkey)));
console.log('WITHDRAW_RING_VK_HASH=' + hash);
"
```

Update contracts/.env with the new VK hash and redeploy ShieldedPool.

### 7. Forge tests

```bash
cd contracts && forge test -vv
# Expected: 60+ tests passing
```

---

## Checklist After Changing a .circom File

1. Recompile the circuit (circom ...)
2. Re-run groth16 setup -> finalize zkey -> export vkey.json and Solidity verifier
3. Copy new WASM + zkey to frontend/public/circuits/
4. Recompute VK hash and update contracts/.env
5. Redeploy ShieldedPool.sol (VK hash is immutable in the constructor)
6. Update zkVerify domain registration with new vkey
7. forge test

---

## Deployed VK Hashes (Base Sepolia)

| Circuit | VK hash |
|---|---|
| withdraw_ring | 0x3c7529ffc44c852ad3b1b566a976ea29f379eec2a2edadb7ade311a432962e49 |
| collateral_ring | Recompiled in session 2 (commitment formula fix) — check circuits/keys/collateral_ring_vkey.json |
