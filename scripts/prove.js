#!/usr/bin/env node
/**
 * ShieldLend Proof Generation Script
 * ====================================
 * Generates Groth16 proofs for all 3 circuits.
 * Used both for testing and as the reference for the frontend.
 *
 * Usage:
 *   node scripts/prove.js deposit   --nullifier <hex> --secret <hex> --amount <wei>
 *   node scripts/prove.js withdraw  --nullifier <hex> --secret <hex> --amount <wei> --root <hex> --path <json>
 *   node scripts/prove.js collateral --collateral <wei> --borrowed <wei> --ratio <int>
 *
 * The snarkjs workflow:
 *   1. Provide input signals as JSON
 *   2. snarkjs generates the witness (fills in all intermediate signal values)
 *   3. snarkjs creates the Groth16 proof using the .zkey (proving key)
 *   4. The proof + public signals are submitted to zkVerify
 */

const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const path = require("path");
const fs = require("fs");

const KEYS_DIR = path.join(__dirname, "../circuits/keys");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate a random field element (for nullifier/secret generation)
// ─────────────────────────────────────────────────────────────────────────────
function randomFieldElement() {
  const FIELD_SIZE = BigInt(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617"
  );
  // Use crypto.getRandomValues for cryptographic randomness
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const hex = Buffer.from(arr).toString("hex");
  return BigInt("0x" + hex) % FIELD_SIZE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deposit proof
// ─────────────────────────────────────────────────────────────────────────────
async function generateDepositProof({ nullifier, secret, amount }) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const nullifierBig = BigInt(nullifier);
  const secretBig = BigInt(secret);
  const amountBig = BigInt(amount);

  // Compute what the circuit will output (for verification)
  const commitment = F.toObject(poseidon([nullifierBig, secretBig, amountBig]));
  const nullifierHash = F.toObject(poseidon([nullifierBig]));

  console.log("Deposit inputs:");
  console.log("  nullifier:    ", nullifierBig.toString(16));
  console.log("  secret:       ", secretBig.toString(16));
  console.log("  amount:       ", amountBig.toString());
  console.log("Expected outputs:");
  console.log("  commitment:   ", commitment.toString(16));
  console.log("  nullifierHash:", nullifierHash.toString(16));

  const input = {
    nullifier: nullifierBig.toString(),
    secret: secretBig.toString(),
    amount: amountBig.toString(),
  };

  const wasmPath = path.join(KEYS_DIR, "deposit_js/deposit.wasm");
  const zkeyPath = path.join(KEYS_DIR, "deposit.zkey");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  console.log("\nProof generated successfully.");
  console.log("Public signals:", publicSignals);

  return { proof, publicSignals, commitment, nullifierHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// Withdraw proof
// ─────────────────────────────────────────────────────────────────────────────
async function generateWithdrawProof({
  nullifier,
  secret,
  amount,
  root,
  pathElements,
  pathIndices,
  recipient,
}) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const nullifierHashBig = F.toObject(poseidon([BigInt(nullifier)]));

  const input = {
    nullifier: BigInt(nullifier).toString(),
    secret: BigInt(secret).toString(),
    pathElements: pathElements.map((e) => BigInt(e).toString()),
    pathIndices: pathIndices.map((i) => i.toString()),
    root: BigInt(root).toString(),
    nullifierHash: nullifierHashBig.toString(),
    recipient: BigInt(recipient).toString(),
    amount: BigInt(amount).toString(),
  };

  console.log("Withdraw inputs:");
  console.log("  root:         ", root);
  console.log("  nullifierHash:", nullifierHashBig.toString(16));
  console.log("  recipient:    ", recipient);
  console.log("  amount:       ", amount);

  const wasmPath = path.join(KEYS_DIR, "withdraw_js/withdraw.wasm");
  const zkeyPath = path.join(KEYS_DIR, "withdraw.zkey");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  console.log("\nProof generated successfully.");
  console.log("Public signals:", publicSignals);

  return { proof, publicSignals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Collateral proof
// ─────────────────────────────────────────────────────────────────────────────
async function generateCollateralProof({ collateral, borrowed, ratio }) {
  const collateralBig = BigInt(collateral);
  const borrowedBig = BigInt(borrowed);
  const ratioBig = BigInt(ratio);

  // Sanity check: collateral * 10000 >= ratio * borrowed
  const lhs = collateralBig * 10000n;
  const rhs = ratioBig * borrowedBig;
  if (lhs < rhs) {
    throw new Error(
      `Insufficient collateral: ${lhs} < ${rhs} (collateral * 10000 < ratio * borrowed)`
    );
  }

  console.log("Collateral proof inputs:");
  console.log("  collateral:", collateralBig.toString());
  console.log("  borrowed:  ", borrowedBig.toString());
  console.log("  ratio:     ", ratioBig.toString());
  console.log(`  Check: ${lhs} >= ${rhs} ✓`);

  const input = {
    collateral: collateralBig.toString(),
    borrowed: borrowedBig.toString(),
    ratio: ratioBig.toString(),
  };

  const wasmPath = path.join(KEYS_DIR, "collateral_js/collateral.wasm");
  const zkeyPath = path.join(KEYS_DIR, "collateral.zkey");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  console.log("\nProof generated successfully.");
  console.log("Public signals:", publicSignals);

  return { proof, publicSignals };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const circuit = process.argv[2];

  if (circuit === "deposit") {
    const nullifier = process.env.NULLIFIER || randomFieldElement().toString();
    const secret = process.env.SECRET || randomFieldElement().toString();
    const amount = process.env.AMOUNT || "1000000000000000000"; // 1 ETH in wei

    const result = await generateDepositProof({ nullifier, secret, amount });

    // Save note for use in withdrawal
    const note = { nullifier, secret, amount, ...result };
    fs.writeFileSync("note.json", JSON.stringify(note, null, 2));
    console.log("\nNote saved to note.json (KEEP THIS SECRET)");
  } else if (circuit === "withdraw") {
    const noteFile = process.env.NOTE_FILE || "note.json";
    const note = JSON.parse(fs.readFileSync(noteFile));
    const root = process.env.ROOT;
    const recipient = process.env.RECIPIENT;
    const pathFile = process.env.PATH_FILE || "merkle_path.json";
    const { pathElements, pathIndices } = JSON.parse(fs.readFileSync(pathFile));

    await generateWithdrawProof({
      ...note,
      root,
      pathElements,
      pathIndices,
      recipient,
    });
  } else if (circuit === "collateral") {
    const collateral = process.env.COLLATERAL || "1500000000000000000"; // 1.5 ETH
    const borrowed = process.env.BORROWED || "1000000000000000000"; // 1 ETH
    const ratio = process.env.RATIO || "15000"; // 150%

    await generateCollateralProof({ collateral, borrowed, ratio });
  } else {
    console.error("Usage: node scripts/prove.js [deposit|withdraw|collateral]");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
