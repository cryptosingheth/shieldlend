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

const { zkVerifySession, ZkVerifyEvents, Library, CurveType } = require("zkverifyjs");
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

const KEYS_DIR = path.join(__dirname, "../circuits/keys");

// zkVerify network configuration
// Network: "Volta" = testnet with latest features
// Docs: https://docs.zkverify.io/overview/getting-started/zkverify-js
const SEED_PHRASE = process.env.ZKVERIFY_SEED_PHRASE;

/**
 * Submit a Groth16 proof to zkVerify and wait for aggregation.
 *
 * zkVerify's model (2026):
 *   Proofs are batched into "aggregations". Your proof gets a `statement`
 *   (leaf digest in the aggregation Merkle tree). Once the aggregation is
 *   published, you get a `statementPath` — a Merkle proof that your proof
 *   was included. This path is what ShieldedPool.sol verifies on-chain.
 *
 * @param {string} circuit       - "deposit", "withdraw", or "collateral"
 * @param {object} proof         - Groth16 proof from snarkjs
 * @param {string[]} publicSignals - Public signals from snarkjs
 * @param {number} domainId      - zkVerify domain ID (0 = default)
 * @returns {Promise<{statement, aggregationId, statementPath, txHash}>}
 */
async function submitToZkVerify(circuit, proof, publicSignals, domainId = 0) {
  if (!SEED_PHRASE) {
    throw new Error("Set ZKVERIFY_SEED_PHRASE environment variable");
  }

  const vkeyPath = path.join(KEYS_DIR, `${circuit}_vkey.json`);
  const vkey = JSON.parse(fs.readFileSync(vkeyPath));

  console.log(`\n[zkVerify] Submitting ${circuit} proof to Volta testnet...`);

  // Verify locally before spending gas on zkVerify chain
  const localValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!localValid) {
    throw new Error("Local proof verification failed — aborting zkVerify submission");
  }
  console.log("[zkVerify] Local proof check: PASS");

  const session = await zkVerifySession.start()
    .Volta()
    .withAccount(SEED_PHRASE);

  try {
    // Submit proof — groth16 with snarkjs library on BN128 curve
    const { events, transactionResult } = await session
      .verify()
      .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
      .execute({
        proofData: { vk: vkey, proof, publicSignals },
        domainId,
      });

    let statement = null;
    let aggregationId = null;
    let statementPath = null;

    // Step 1: proof included in a block → get statement (leaf digest)
    events.on(ZkVerifyEvents.IncludedInBlock, (eventData) => {
      console.log(`[zkVerify] Included in block: ${eventData.blockHash}`);
      statement = eventData.statement;
      aggregationId = eventData.aggregationId;
      console.log(`  statement:     ${statement}`);
      console.log(`  aggregationId: ${aggregationId}`);
    });

    // Step 2: aggregation published → get Merkle path for on-chain verification
    session.subscribe([
      {
        event: ZkVerifyEvents.NewAggregationReceipt,
        options: { domainId },
        callback: async (eventData) => {
          const incomingAggId = parseInt(
            eventData.data.aggregationId.replace(/,/g, "")
          );
          if (aggregationId === incomingAggId) {
            console.log(`[zkVerify] Aggregation ${aggregationId} published!`);
            // Get Merkle path for on-chain verification
            statementPath = await session.getAggregateStatementPath(
              eventData.blockHash,
              parseInt(eventData.data.domainId),
              incomingAggId,
              statement
            );
            console.log(`  statementPath: ${JSON.stringify(statementPath)}`);
          }
        },
      },
    ]);

    const result = await transactionResult;
    console.log(`[zkVerify] Transaction: ${result.txHash}`);

    // Wait for aggregation (may take a few minutes on Volta)
    const maxWait = 5 * 60 * 1000; // 5 minutes
    const deadline = Date.now() + maxWait;
    while (!statementPath && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!statementPath) {
      console.warn("[zkVerify] Aggregation not yet published — saving partial result");
    }

    return {
      statement,
      aggregationId,
      statementPath,
      txHash: result.txHash,
    };
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
