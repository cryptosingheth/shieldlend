pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

/*
 * Withdrawal Circuit — ShieldLend
 *
 * This is the core privacy circuit. It proves THREE things simultaneously
 * without revealing which deposit is being withdrawn:
 *
 *  1. MEMBERSHIP: I know a leaf (commitment) in the Merkle tree
 *     → proves I made a deposit (without revealing which one)
 *
 *  2. KNOWLEDGE: I know (nullifier, secret) such that commitment = Poseidon(nullifier, secret, amount)
 *     → proves I am the rightful owner of that deposit
 *
 *  3. SPENDING: The nullifierHash = Poseidon(nullifier)
 *     → the contract checks this hasn't been seen before (prevents double-spend)
 *
 * Revision note — Merkle proof structure:
 *   A Merkle tree with `levels` layers has 2^levels leaves.
 *   To prove a leaf is in the tree, you provide the "path":
 *     - pathElements[i]: the sibling hash at level i
 *     - pathIndices[i]: 0 if you're the left child, 1 if right
 *   The verifier recomputes the root from (leaf, pathElements, pathIndices).
 *   If the recomputed root == the current on-chain root → membership proven.
 *
 * Privacy property:
 *   The Merkle proof reveals the PATH but NOT the leaf index.
 *   (Technically, the path itself leaks partial info in tiny trees, but
 *   with 2^20 = 1M leaves, the anonymity set is large enough in practice.)
 */
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hashers[levels];
    component mux[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0; // must be 0 or 1

        hashers[i] = Poseidon(2);
        mux[i] = MultiMux1(2);

        mux[i].c[0][0] <== levelHashes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== levelHashes[i];

        mux[i].s <== pathIndices[i];

        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        levelHashes[i + 1] <== hashers[i].out;
    }

    root === levelHashes[levels];
}

template Withdraw(levels) {
    // ── Private inputs ──────────────────────────────────────────────────────
    signal input nullifier;              // spending key — reveals WHICH note is spent (via nullifierHash)
    signal input secret;                 // authentication secret
    signal input pathElements[levels];   // Merkle sibling hashes along the path to root
    signal input pathIndices[levels];    // 0=left, 1=right at each level

    // ── Public inputs ────────────────────────────────────────────────────────
    signal input root;         // current Merkle root from ShieldedPool.getRoot()
    signal input nullifierHash;// = Poseidon(nullifier); checked against spent set on-chain
    signal input recipient;    // withdrawal destination address (prevents front-running)
    signal input amount;       // amount to withdraw; must match committed amount

    // ── Step 1: Verify nullifierHash is correctly computed ────────────────────
    // This links the public nullifierHash to the private nullifier.
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // ── Step 2: Recompute the commitment leaf ─────────────────────────────────
    // commitment = Poseidon(nullifier, secret, amount)
    // This is the same formula as deposit.circom — enforces that amount_out == amount_deposited.
    component commitHasher = Poseidon(3);
    commitHasher.inputs[0] <== nullifier;
    commitHasher.inputs[1] <== secret;
    commitHasher.inputs[2] <== amount;

    // ── Step 3: Merkle membership proof ──────────────────────────────────────
    // Proves that commitHasher.out is a leaf in the tree with the given root.
    component treeChecker = MerkleTreeChecker(levels);
    treeChecker.leaf <== commitHasher.out;
    treeChecker.root <== root;
    for (var i = 0; i < levels; i++) {
        treeChecker.pathElements[i] <== pathElements[i];
        treeChecker.pathIndices[i] <== pathIndices[i];
    }

    // ── Step 4: Bind recipient to proof (anti front-running) ─────────────────
    // Include recipient in the circuit so a malicious relayer can't replace it.
    // This is a dummy constraint to "use" the recipient signal — prevents
    // the optimizer from removing it.
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

// 20 levels → 2^20 = ~1M possible deposits (sufficient anonymity set)
// Public inputs: root, nullifierHash, recipient, amount
// Private inputs: nullifier, secret, pathElements[], pathIndices[]
component main {public [root, nullifierHash, recipient, amount]} = Withdraw(20);
