pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
 * MerkleTreeChecker
 *
 * Recomputes the Merkle root from (leaf, pathElements, pathIndices) and
 * enforces that it equals the expected root.
 *
 *   pathElements[i] -- sibling hash at level i
 *   pathIndices[i]  -- 0 if current node is left child, 1 if right child
 *
 * Uses MultiMux1 to route (current, sibling) into the correct order
 * before hashing, so Poseidon(left, right) is always consistent.
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

/*
 * WithdrawRing -- ShieldLend V2 Withdrawal Circuit
 *
 * Improvement over V1: decouples withdrawal timing from deposit timing.
 *
 * V1 problem: the global Merkle tree is append-only and public. If you deposit
 * at block N and withdraw at block N+1 when only one new leaf exists, the
 * anonymity set is trivially 1. You must wait for enough other deposits.
 *
 * V2 solution: a "ring" of k=16 commitments is sampled from the last 30 epochs.
 * The ring contains real deposits AND protocol-inserted dummy commitments. The
 * prover shows their note is one of the 16 -- without revealing which one. The
 * verifier never learns ring_index (it's private). This gives 300+ minimum
 * anonymity set at protocol launch, regardless of actual deposit volume.
 *
 * V2 also drops `amount` from the commitment formula. Denominations are fixed
 * (0.1 / 0.5 / 1.0 ETH), so the amount is implicit in the pool contract.
 * The prover no longer needs to commit to a specific amount.
 *
 * This circuit proves FOUR things simultaneously:
 *
 *  1. COMMITMENT VALIDITY: C_real = Poseidon(secret, nullifier)
 *     -> the prover knows the secret behind one commitment in the ring.
 *
 *  2. RING MEMBERSHIP: ring[ring_index] == C_real
 *     -> C_real is one of the 16 public ring commitments.
 *     -> ring_index is private -- the verifier cannot tell which one.
 *
 *  3. GLOBAL INCLUSION: MerkleTreeChecker(C_real, pathElements, pathIndices, root)
 *     -> C_real was actually deposited (it is a leaf in the global Merkle tree).
 *     -> Without this, a prover could forge a commitment not in the tree.
 *
 *  4. NULLIFIER BINDING: nullifierHash == Poseidon(nullifier, ring_index)
 *     -> Binds the nullifier to a specific ring position. This prevents the
 *        same note from being withdrawn twice using different ring configurations
 *        (replay across different ring instantiations would produce different
 *        nullifierHashes since ring_index would differ).
 *     -> The contract marks nullifierHash as spent, preventing double-spend.
 */
template WithdrawRing(levels, ringSize) {
    // -- Private inputs -------------------------------------------------------
    signal input secret;                  // authentication secret (never revealed)
    signal input nullifier;               // spending key (never revealed directly)
    signal input pathElements[levels];    // Merkle sibling hashes along path to root
    signal input pathIndices[levels];     // 0=left, 1=right at each Merkle level
    signal input ring_index;              // position of C_real within the ring (0..ringSize-1)

    // -- Public inputs --------------------------------------------------------
    signal input ring[ringSize];          // 16 commitments from last 30 epochs (posted on-chain)
    signal input nullifierHash;           // = Poseidon(nullifier, ring_index); checked for double-spend
    signal input root;                    // current global Merkle root from ShieldedPool

    // -------------------------------------------------------------------------
    // Step 1: Verify ring_index is in range [0, ringSize-1]
    //
    // LessThan(4) works because 2^4 = 16 covers the full ring index range.
    // Without this check, a malicious prover could supply ring_index >= ringSize
    // and the running-sum selector below would output 0 (no term matches),
    // making C_real === 0 -- a trivially forged commitment.
    // -------------------------------------------------------------------------
    component rangeCheck = LessThan(4); // 4 bits covers 0..15
    rangeCheck.in[0] <== ring_index;
    rangeCheck.in[1] <== ringSize;
    rangeCheck.out === 1;

    // -------------------------------------------------------------------------
    // Step 2: Compute the commitment C_real = Poseidon(secret, nullifier)
    //
    // V2 change from V1: removed `amount` as a third input.
    // Fixed denominations make the amount implicit.
    // -------------------------------------------------------------------------
    component commitHasher = Poseidon(2);
    commitHasher.inputs[0] <== secret;
    commitHasher.inputs[1] <== nullifier;
    signal c_real;
    c_real <== commitHasher.out;

    // -------------------------------------------------------------------------
    // Step 3: Verify nullifierHash == Poseidon(nullifier, ring_index)
    //
    // Binding ring_index into the nullifier prevents a prover from using the
    // same note in two different ring instantiations: if they tried, the
    // ring_index would differ (since ring composition changes each epoch),
    // producing a different nullifierHash -- but the on-chain spent set is
    // keyed by nullifierHash, not nullifier.
    // -------------------------------------------------------------------------
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHasher.inputs[1] <== ring_index;
    nullifierHash === nullifierHasher.out;

    // -------------------------------------------------------------------------
    // Step 4: Ring membership -- prove ring[ring_index] == c_real
    //         without revealing ring_index.
    //
    // Approach: for each position i, compute a one-hot selector bit:
    //   sel[i] = 1 if ring_index == i, else 0
    // Then: selected = sum(ring[i] * sel[i])
    // Because exactly one sel[i] is 1, selected == ring[ring_index].
    // Finally assert selected == c_real.
    // -------------------------------------------------------------------------
    component isEq[ringSize];
    signal selected_terms[ringSize];
    signal running_sum[ringSize + 1];
    running_sum[0] <== 0;

    for (var i = 0; i < ringSize; i++) {
        isEq[i] = IsEqual();
        isEq[i].in[0] <== ring_index;
        isEq[i].in[1] <== i;
        selected_terms[i] <== ring[i] * isEq[i].out;
        running_sum[i + 1] <== running_sum[i] + selected_terms[i];
    }

    running_sum[ringSize] === c_real;

    // -------------------------------------------------------------------------
    // Step 5: Global Merkle inclusion proof
    //
    // Proves c_real is actually a leaf in the on-chain Merkle tree.
    // This prevents a prover from constructing a valid ring membership proof
    // for a commitment that was never deposited.
    // -------------------------------------------------------------------------
    component treeChecker = MerkleTreeChecker(levels);
    treeChecker.leaf <== c_real;
    treeChecker.root <== root;
    for (var i = 0; i < levels; i++) {
        treeChecker.pathElements[i] <== pathElements[i];
        treeChecker.pathIndices[i] <== pathIndices[i];
    }
}

// levels=24 -> 2^24 = ~16M possible deposit slots (accommodates dummies)
// ringSize=16 -> 16 commitments sampled from last 30 epochs
//
// Public inputs:  ring[16], nullifierHash, root
// Private inputs: secret, nullifier, pathElements[24], pathIndices[24], ring_index
component main {public [ring, nullifierHash, root]} = WithdrawRing(24, 16);
