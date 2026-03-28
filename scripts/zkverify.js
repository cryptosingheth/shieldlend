#!/usr/bin/env node
/**
 * ShieldLend zkVerify Integration
 * =================================
 * Submits Groth16 proofs to zkVerify for off-chain verification.
 * Returns an attestationId that can be used on-chain.
 *
 * Why zkVerify instead of on-chain verification?
 *   On Ethereum L1: verifyProof() costs ~500K gas (~$15-40 per withdrawal)
 *   On zkVerify:    proof submitted once, verified across all chains
 *                   ShieldedPool.sol checks attestationId (~10-50K gas)
 *                   Result: 91% cheaper than on-chain verification
 *
 * zkVerify flow:
 *   1. Generate proof locally (prove.js)
 *   2. Submit proof to zkVerify via zkverifyjs SDK
 *   3. Wait for attestation event (proof is verified by zkVerify validators)
 *   4. Get attestationId from the event
 *   5. Pass attestationId to ShieldedPool.withdraw() on-chain
 *
 * Docs: https://docs.zkverify.io/tutorials/complete-tutorials/zkverify-js
 */

const { zkVerifySession, ZkVerifyEvents, Library } = require("zkverifyjs");
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

const KEYS_DIR = path.join(__dirname, "../circuits/keys");

// zkVerify testnet configuration
// Network: zkVerify testnet (https://docs.zkverify.io)
const ZKVERIFY_CONFIG = {
  network: "testnet",    // use "mainnet" for production
  // Seed phrase from environment (NEVER hardcode)
  seedPhrase: process.env.ZKVERIFY_SEED_PHRASE,
};

/**
 * Submit a Groth16 proof to zkVerify and wait for attestation.
 *
 * @param {string} circuit     - "deposit", "withdraw", or "collateral"
 * @param {object} proof       - Groth16 proof from snarkjs
 * @param {string[]} publicSignals - Public inputs/outputs from snarkjs
 * @returns {Promise<{attestationId: number, leafDigest: string}>}
 */
async function submitToZkVerify(circuit, proof, publicSignals) {
  if (!ZKVERIFY_CONFIG.seedPhrase) {
    throw new Error(
      "Set ZKVERIFY_SEED_PHRASE environment variable (your zkVerify account seed phrase)"
    );
  }

  const vkeyPath = path.join(KEYS_DIR, `${circuit}_vkey.json`);
  const vkey = JSON.parse(fs.readFileSync(vkeyPath));

  console.log(`\n[zkVerify] Submitting ${circuit} proof to zkVerify testnet...`);

  // Start a zkVerify session
  const session = await zkVerifySession.start()
    .Testnet()
    .withAccount(ZKVERIFY_CONFIG.seedPhrase);

  try {
    // Verify the proof locally first (sanity check before submitting)
    const localValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!localValid) {
      throw new Error("Proof failed local verification — not submitting to zkVerify");
    }
    console.log("[zkVerify] Local proof verification: ✓");

    // Submit to zkVerify
    // zkVerifyJS wraps the proof submission into a transaction on the zkVerify chain
    const { events, transactionResult } = await session
      .verify()
      .groth16()
      .execute({
        proofData: {
          vk: vkey,
          proof: proof,
          publicSignals: publicSignals,
        },
        library: Library.SnarkJS, // tells zkVerify this came from snarkjs
      });

    // Listen for attestation confirmation
    let attestationId = null;
    let leafDigest = null;

    events.on(ZkVerifyEvents.IncludedInBlock, (eventData) => {
      console.log(`[zkVerify] Proof included in block: ${eventData.blockHash}`);
    });

    events.on(ZkVerifyEvents.Finalized, (eventData) => {
      console.log(`[zkVerify] Proof finalized!`);
      console.log(`  attestationId: ${eventData.attestationId}`);
      console.log(`  leafDigest:    ${eventData.leafDigest}`);
      attestationId = eventData.attestationId;
      leafDigest = eventData.leafDigest;
    });

    // Wait for the transaction to complete
    const result = await transactionResult;
    console.log(`[zkVerify] Transaction hash: ${result.txHash}`);

    if (!attestationId) {
      throw new Error("Attestation event not received");
    }

    return { attestationId, leafDigest, txHash: result.txHash };
  } finally {
    await session.close();
  }
}

/**
 * Verify that an attestation is valid on the zkVerify chain.
 * This is the check that ShieldedPool.sol will do on-chain.
 */
async function verifyAttestation(attestationId, leafDigest) {
  const session = await zkVerifySession.start()
    .Testnet()
    .readOnly(); // read-only — no account needed for verification

  try {
    const isValid = await session.verify()
      .attestation(attestationId, leafDigest);

    console.log(`[zkVerify] Attestation ${attestationId}: ${isValid ? "VALID ✓" : "INVALID ✗"}`);
    return isValid;
  } finally {
    await session.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const command = process.argv[2];

  if (command === "submit") {
    const circuit = process.argv[3]; // deposit, withdraw, or collateral
    const proofFile = process.argv[4]; // path to proof JSON from snarkjs

    if (!circuit || !proofFile) {
      console.error("Usage: node scripts/zkverify.js submit <circuit> <proof.json>");
      process.exit(1);
    }

    const proofData = JSON.parse(fs.readFileSync(proofFile));
    const { proof, publicSignals } = proofData;

    const result = await submitToZkVerify(circuit, proof, publicSignals);

    // Save attestation for use in withdrawal transaction
    const outputFile = `${circuit}_attestation.json`;
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
    console.log(`\nAttestation saved to ${outputFile}`);
    console.log(`Use attestationId ${result.attestationId} in ShieldedPool.withdraw()`);
  } else if (command === "verify") {
    const attestationId = process.argv[3];
    const leafDigest = process.argv[4];
    await verifyAttestation(Number(attestationId), leafDigest);
  } else {
    console.error("Usage: node scripts/zkverify.js [submit|verify]");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
