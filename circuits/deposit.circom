pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";

/*
 * Deposit Circuit — ShieldLend
 *
 * Proves that a commitment is correctly computed from (nullifier, secret, amount).
 * This binds the deposited amount to the commitment stored in the Merkle tree.
 *
 * Privacy model:
 *   - nullifier and secret are PRIVATE — only the depositor knows them
 *   - amount is PUBLIC — must match msg.value on-chain (cannot hide from contract)
 *   - commitment is PUBLIC OUTPUT — stored in ShieldedPool's Merkle tree
 *   - nullifierHash is PUBLIC OUTPUT — pre-computed to prevent double-spend at withdrawal
 *
 * Revision note:
 *   Poseidon is a ZK-friendly hash — ~100x fewer constraints than SHA256.
 *   Pedersen is also ZK-friendly but Poseidon is the current standard in circomlib.
 *   Both are collision-resistant; Poseidon is preferred for new circuits.
 */
template Deposit() {
    // ── Private inputs ──────────────────────────────────────────────────────
    signal input nullifier;  // random value — spending key; never reuse
    signal input secret;     // random value — authentication secret

    // ── Public inputs ────────────────────────────────────────────────────────
    signal input amount;     // must equal msg.value in ShieldedPool.deposit()

    // ── Public outputs ───────────────────────────────────────────────────────
    signal output commitment;    // = Poseidon(nullifier, secret, amount)
    signal output nullifierHash; // = Poseidon(nullifier) — pre-computed for efficiency

    // ── Commitment: binds (nullifier, secret) to amount ──────────────────────
    // commitment = Poseidon(nullifier, secret, amount)
    // During withdrawal, the withdraw circuit proves that Poseidon(nullifier, secret, amount_out)
    // is a leaf in the Merkle tree — this enforces amount_out == amount_deposited.
    component commitHasher = Poseidon(3);
    commitHasher.inputs[0] <== nullifier;
    commitHasher.inputs[1] <== secret;
    commitHasher.inputs[2] <== amount;
    commitment <== commitHasher.out;

    // ── NullifierHash: public identifier for double-spend prevention ──────────
    // nullifierHash = Poseidon(nullifier)
    // The contract stores nullifierHash after a successful withdrawal.
    // A second withdrawal with the same nullifier is rejected on-chain.
    // The nullifierHash does NOT reveal the nullifier (Poseidon is one-way).
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash <== nullifierHasher.out;
}

// Public inputs declared in main: [amount]
// Outputs (commitment, nullifierHash) are always public in Circom.
// Private inputs: nullifier, secret (not listed → default private)
component main {public [amount]} = Deposit();
