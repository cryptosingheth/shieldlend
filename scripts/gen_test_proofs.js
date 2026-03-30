#!/usr/bin/env node
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

const BUILD = path.join(__dirname, "../circuits/build");

async function genProof(name, input) {
    const wasm = path.join(BUILD, `${name}_js/${name}.wasm`);
    const zkey = path.join(BUILD, `${name}_final.zkey`);
    const vkey = JSON.parse(fs.readFileSync(path.join(BUILD, `${name}_vkey.json`)));

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);

    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!ok) throw new Error(`${name}: local verify failed`);

    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    return { name, proof, publicSignals, calldata };
}

async function main() {
    const results = {};

    // --- DEPOSIT ---
    // Private: nullifier=123, secret=456; Public: amount=1000
    results.deposit = await genProof("deposit", {
        nullifier: "123",
        secret: "456",
        amount: "1000",
    });

    // --- COLLATERAL ---
    // Private: collateral=2000; Public: borrowed=1000, ratio=15000
    // 2000*10000 = 20_000_000 >= 15000*1000 = 15_000_000 ✓
    results.collateral = await genProof("collateral", {
        collateral: "2000",
        borrowed: "1000",
        ratio: "15000",
    });

    // --- WITHDRAW ---
    // Build a valid Merkle tree with the commitment as a leaf
    // commitment = Poseidon(nullifier=123, secret=456, amount=1000) — computed by deposit circuit
    // We get the commitment from the deposit proof's public signals
    const depositPub = results.deposit.publicSignals;
    // deposit circuit outputs: [commitment, nullifierHash, amount]
    // Actually the public signals order for snarkjs: outputs first, then public inputs
    // deposit.circom: outputs = [commitment, nullifierHash], public inputs = [amount]
    // So: publicSignals = [commitment, nullifierHash, amount]
    const commitment = depositPub[0];
    const nullifierHash = depositPub[1];

    // For withdraw circuit, we need a Merkle tree containing this commitment.
    // Build a dummy 20-level tree with commitment at index 0, all siblings = 0
    const pathElements = Array(20).fill("0");
    const pathIndices = Array(20).fill("0");

    // Compute the Merkle root by hashing up from the commitment with zero siblings
    // We need Poseidon to compute the root — use circomlibjs
    let currentHash = commitment;
    const { buildPoseidon } = require("circomlibjs");
    const poseidon = await buildPoseidon();

    for (let i = 0; i < 20; i++) {
        const left = BigInt(currentHash);
        const right = BigInt(0);
        currentHash = poseidon.F.toString(poseidon([left, right]));
    }
    const root = currentHash;

    results.withdraw = await genProof("withdraw", {
        nullifier: "123",
        secret: "456",
        pathElements,
        pathIndices,
        root,
        nullifierHash,
        recipient: "12345678",
        amount: "1000",
    });

    // Output Solidity-ready calldata
    const output = {};
    for (const [name, r] of Object.entries(results)) {
        output[name] = {
            calldata: r.calldata,
            publicSignals: r.publicSignals,
        };
    }

    const outPath = path.join(BUILD, "test_proofs.json");
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`Proofs written to ${outPath}`);

    // Also print the raw calldata for easy embedding in Solidity
    for (const [name, r] of Object.entries(results)) {
        console.log(`\n=== ${name.toUpperCase()} ===`);
        console.log(`Public signals: [${r.publicSignals.join(", ")}]`);
        console.log(`Calldata:\n${r.calldata}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
