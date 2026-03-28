#!/usr/bin/env node
/**
 * ShieldLend E2E Test — Local Anvil
 * ===================================
 * Tests the full private deposit → withdrawal flow on a local Anvil node.
 *
 * Flow:
 *   1. Generate a deposit note (nullifier + secret + commitment)
 *   2. Call ShieldedPool.deposit(commitment) with 0.1 ETH
 *   3. Generate a Groth16 withdrawal proof (withdraw.circom)
 *   4. Verify the proof locally (skipping zkVerify for local testing)
 *   5. Call ShieldedPool.withdraw() with the proof + attestation stub
 *
 * Prerequisites:
 *   - Anvil running on port 8545
 *   - Contracts deployed (addresses set in DEPLOYED_ADDRESSES below)
 *   - Run: node scripts/e2e_test.js
 */

const snarkjs = require("snarkjs");
const circomlibjs = require("circomlibjs");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// Contract addresses from Anvil deployment
const DEPLOYED_ADDRESSES = {
  shieldedPool: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  lendingPool: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  nullifierRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  collateralVerifier: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
};

// Anvil test account #0
const RPC_URL = "http://127.0.0.1:8545";
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Minimal ABIs
const SHIELDED_POOL_ABI = [
  "function deposit(bytes32 commitment) external payable",
  "function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 amount, uint256 attestationId) external",
  "function getLastRoot() external view returns (bytes32)",
  "function nextIndex() external view returns (uint32)",
  "event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp, uint256 amount)",
];

const KEYS_DIR = path.join(__dirname, "../circuits/keys");
const BUILD_DIR = path.join(__dirname, "../circuits/build");

function fieldToBytes32(value) {
  return "0x" + value.toString(16).padStart(64, "0");
}

async function buildMerklePath(provider, poolContract, leafIndex, targetRoot) {
  const LEVELS = 20;
  const poseidon = await circomlibjs.buildPoseidon();
  const F = poseidon.F;

  // Get all deposit events
  const filter = poolContract.filters.Deposit();
  const events = await poolContract.queryFilter(filter, 0, "latest");

  const commitments = new Array(2 ** LEVELS).fill(0n);
  for (const event of events) {
    const idx = Number(event.args.leafIndex);
    commitments[idx] = BigInt(event.args.commitment);
  }

  // Build tree bottom-up
  let layers = [commitments];
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const current = layers[lvl];
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? 0n;
      next.push(F.toObject(poseidon([left, right])));
    }
    layers.push(next);
  }

  const pathElements = [];
  const pathIndices = [];
  let idx = leafIndex;
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const isRight = idx % 2;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    pathIndices.push(isRight);
    pathElements.push(layers[lvl][siblingIdx] ?? 0n);
    idx = Math.floor(idx / 2);
  }

  const root = layers[LEVELS][0];
  return { pathElements, pathIndices, root };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const poolContract = new ethers.Contract(
    DEPLOYED_ADDRESSES.shieldedPool,
    SHIELDED_POOL_ABI,
    wallet
  );

  const poseidon = await circomlibjs.buildPoseidon();
  const F = poseidon.F;

  // ─── Step 1: Create note ─────────────────────────────────────────────────
  console.log("\n[1] Creating deposit note...");
  const nullifier = 12345678901234567890n;
  const secret = 98765432109876543210n;
  const amount = ethers.parseEther("0.1"); // 0.1 ETH

  const commitment = F.toObject(poseidon([nullifier, secret, amount]));
  const nullifierHash = F.toObject(poseidon([nullifier]));
  const commitmentHex = fieldToBytes32(commitment);
  const nullifierHashHex = fieldToBytes32(nullifierHash);

  console.log("  commitment:    ", commitmentHex);
  console.log("  nullifierHash: ", nullifierHashHex);

  // ─── Step 2: Deposit on-chain ─────────────────────────────────────────────
  console.log("\n[2] Depositing 0.1 ETH into ShieldedPool...");
  const depositTx = await poolContract.deposit(commitmentHex, { value: amount });
  const depositReceipt = await depositTx.wait();
  console.log("  tx:", depositReceipt.hash);

  const depositEvent = depositReceipt.logs
    .map((l) => {
      try {
        return poolContract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e?.name === "Deposit");

  const leafIndex = Number(depositEvent.args.leafIndex);
  console.log("  leafIndex:", leafIndex);

  // Get current root
  const currentRoot = await poolContract.getLastRoot();
  console.log("  merkleRoot:", currentRoot);

  // ─── Step 3: Build Merkle path ───────────────────────────────────────────
  console.log("\n[3] Building Merkle path...");
  const merklePath = await buildMerklePath(provider, poolContract, leafIndex, currentRoot);
  console.log("  pathIndices:", merklePath.pathIndices.slice(0, 5), "...");

  // ─── Step 4: Generate withdrawal proof ───────────────────────────────────
  console.log("\n[4] Generating withdrawal proof (this takes ~10-30s)...");
  const recipient = wallet.address;

  const withdrawInput = {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    pathElements: merklePath.pathElements.map((e) => e.toString()),
    pathIndices: merklePath.pathIndices.map((i) => i.toString()),
    root: merklePath.root.toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: BigInt(recipient).toString(),
    amount: amount.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    withdrawInput,
    path.join(BUILD_DIR, "withdraw_js/withdraw.wasm"),
    path.join(KEYS_DIR, "withdraw_final.zkey")
  );

  // ─── Step 5: Verify proof locally ────────────────────────────────────────
  console.log("\n[5] Verifying withdrawal proof locally...");
  const vkey = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, "withdraw_vkey.json")));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("  Proof valid:", valid);

  if (!valid) throw new Error("Proof verification failed!");

  // ─── Step 6: Submit proof to ShieldedPool ────────────────────────────────
  // For local testing: skip zkVerify and call with a stub attestation ID
  // In production: submit proof to zkVerify and use the real attestation ID
  console.log("\n[6] Submitting withdrawal to ShieldedPool (stub attestation)...");

  // Encode proof as bytes (Groth16 has [pA, pB, pC])
  const proofBytes = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      [
        [proof.pi_b[0][1], proof.pi_b[0][0]],
        [proof.pi_b[1][1], proof.pi_b[1][0]],
      ],
      [proof.pi_c[0], proof.pi_c[1]],
    ]
  );

  const rootHex = fieldToBytes32(merklePath.root);
  const recipientBalance_before = await provider.getBalance(recipient);

  const withdrawTx = await poolContract.withdraw(
    proofBytes,
    rootHex,
    nullifierHashHex,
    recipient,
    amount,
    0n // attestation stub (zkVerify integration happens in production flow)
  );
  const withdrawReceipt = await withdrawTx.wait();
  console.log("  tx:", withdrawReceipt.hash);

  const recipientBalance_after = await provider.getBalance(recipient);
  const balanceDelta = recipientBalance_after - recipientBalance_before;
  console.log("  Balance delta:", ethers.formatEther(balanceDelta), "ETH");

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log("\n=== E2E Test PASSED ===");
  console.log("Private deposit + ZK withdrawal completed successfully on Anvil");
  console.log("Proof generation: Groth16 (withdraw.circom, 6020 constraints)");
  console.log("Hash function: Poseidon (matches circuit-contract alignment)");
}

main().catch((err) => {
  console.error("\n=== E2E Test FAILED ===");
  console.error(err);
  process.exit(1);
});
