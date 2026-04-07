pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
 * MerkleTreeChecker -- copied verbatim from withdraw_ring.circom.
 * See withdraw_ring.circom for full explanation.
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
 * CollateralRing -- ShieldLend V2 Borrow Collateral Circuit
 *
 * Improvement over V1 (collateral.circom):
 *
 * V1 problem: `collateral` was a raw private input with no link to an actual
 * on-chain deposit. A prover could claim any collateral value. The circuit
 * proved the ratio inequality, but not that the collateral actually exists.
 *
 * V2 solution: the prover supplies (secret, nullifier) -- the same pair used
 * at deposit time. The circuit:
 *   (a) recomputes the commitment C_real = Poseidon(secret, nullifier, denomination)
 *       -- denomination IS included so the commitment binds the note's value.
 *   (b) proves C_real is in the public ring (ring membership).
 *   (c) proves C_real is in the global Merkle tree (it was actually deposited).
 *   (d) proves denomination * minRatioBps >= borrowed * 10000 (LTV check).
 *
 * Why denomination is private:
 *   Denominations are fixed (0.1 / 0.5 / 1.0 ETH in wei). If denomination were
 *   public, an observer could narrow which ring member the prover owns, reducing
 *   anonymity to the subset of notes at that denomination. Keeping it private
 *   hides the collateral size while still proving it satisfies the LTV ratio.
 *
 * Commitment formula matches WithdrawRing:
 *   Both circuits use Poseidon(secret, nullifier) — no denomination in the hash.
 *   denomination is a private witness used only for the LTV inequality (Step 6).
 *   It is NOT committed on-chain. This ensures the same deposited leaf works for
 *   both withdraw and borrow proofs. (Production: a denomination-binding deposit
 *   circuit would add a separate commitment type to bind the amount on-chain.)
 *
 * This circuit proves FIVE things:
 *
 *  1. COMMITMENT VALIDITY: C_real = Poseidon(secret, nullifier, denomination)
 *     -> prover knows the secret and the denomination of a specific note.
 *
 *  2. RING MEMBERSHIP: ring[ring_index] == C_real
 *     -> C_real is one of the 16 public ring commitments (ring_index is private).
 *
 *  3. GLOBAL INCLUSION: MerkleTreeChecker(C_real, pathElements, pathIndices, root)
 *     -> C_real was actually deposited into the pool.
 *
 *  4. NULLIFIER BINDING: nullifierHash == Poseidon(nullifier)
 *     -> Links this borrow to the note itself, independent of ring position.
 *        Matches the H-3 fix in withdraw_ring: the same note produces the same
 *        nullifierHash regardless of which ring epoch it lands in.
 *
 *  5. COLLATERAL SUFFICIENCY: denomination * minRatioBps >= borrowed * 10000
 *     -> The note's value is sufficient collateral for the loan at the
 *        protocol's minimum LTV ratio -- without revealing the denomination.
 */
template CollateralRing(levels, ringSize) {
    // -- Private inputs -------------------------------------------------------
    signal input secret;                  // authentication secret (never revealed)
    signal input nullifier;               // spending key (never revealed directly)
    signal input pathElements[levels];    // Merkle sibling hashes along path to root
    signal input pathIndices[levels];     // 0=left, 1=right at each Merkle level
    signal input ring_index;              // position of C_real in the ring (0..ringSize-1)
    signal input denomination;            // note value in wei (e.g., 1e17 = 0.1 ETH)

    // -- Public inputs --------------------------------------------------------
    signal input ring[ringSize];          // 16 collateral commitments from last 30 epochs
    signal input nullifierHash;           // = Poseidon(nullifier); tracks open borrow positions
    signal input root;                    // current global Merkle root
    signal input borrowed;               // loan amount in wei (posted on-chain by borrower)
    signal input minRatioBps;            // minimum collateral ratio in basis points (e.g., 5000 = 50% LTV)

    // -------------------------------------------------------------------------
    // Step 1: Verify ring_index is in range [0, ringSize-1]
    //
    // Same rationale as WithdrawRing: prevents a prover from supplying an
    // out-of-range index that would make the ring selector output 0.
    // -------------------------------------------------------------------------
    component rangeCheck = LessThan(4); // 4 bits covers 0..15
    rangeCheck.in[0] <== ring_index;
    rangeCheck.in[1] <== ringSize;
    rangeCheck.out === 1;

    // -------------------------------------------------------------------------
    // Step 2: Compute C_real = Poseidon(secret, nullifier, denomination)
    //
    // H-1 consistency fix: matches withdraw_ring.circom's updated commitment
    // formula. The denomination is now part of the commitment hash, so the
    // Merkle inclusion proof guarantees the prover cannot lie about the note's
    // value in the LTV check — any wrong denomination produces a different
    // c_real that won't match any ring member or Merkle leaf.
    // -------------------------------------------------------------------------
    component commitHasher = Poseidon(3);
    commitHasher.inputs[0] <== secret;
    commitHasher.inputs[1] <== nullifier;
    commitHasher.inputs[2] <== denomination;
    signal c_real;
    c_real <== commitHasher.out;

    // -------------------------------------------------------------------------
    // Step 3: Verify nullifierHash == Poseidon(nullifier)
    //
    // H-3 fix: ring_index removed. The lending contract stores nullifierHash to
    // mark an open borrow position. Using just Poseidon(nullifier) ensures the
    // same note produces the same collateral lock tag across epochs.
    // -------------------------------------------------------------------------
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // -------------------------------------------------------------------------
    // Step 4: Ring membership -- prove ring[ring_index] == c_real
    //         without revealing ring_index.
    //
    // Identical selector approach to WithdrawRing.
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
    // Proves c_real is a leaf in the on-chain Merkle tree.
    // -------------------------------------------------------------------------
    component treeChecker = MerkleTreeChecker(levels);
    treeChecker.leaf <== c_real;
    treeChecker.root <== root;
    for (var i = 0; i < levels; i++) {
        treeChecker.pathElements[i] <== pathElements[i];
        treeChecker.pathIndices[i] <== pathIndices[i];
    }

    // -------------------------------------------------------------------------
    // Step 6: Collateral sufficiency -- denomination * minRatioBps >= borrowed * 10000
    //
    // Intuition: minRatioBps is the LTV floor in basis points.
    //   minRatioBps = 5000 -> max 50% LTV -> need collateral worth 2x the loan.
    //   Rearranged (integer arithmetic, no division):
    //     denomination * minRatioBps >= borrowed * 10000
    //
    // Example:
    //   denomination = 1e18 (1 ETH), borrowed = 4e17 (0.4 ETH), minRatioBps = 5000
    //   LHS = 1e18 * 5000 = 5e21
    //   RHS = 4e17 * 10000 = 4e21
    //   5e21 >= 4e21 -- pass (LTV = 40%, under the 50% cap)
    //
    // n=96: max denomination ~1e18, minRatioBps <=20000 -> LHS <=2e22 <2^74.
    //       Both products fit in 96 bits.
    // -------------------------------------------------------------------------
    signal lhs;
    signal rhs;
    lhs <== denomination * minRatioBps;
    rhs <== borrowed * 10000;

    component gte = GreaterEqThan(96);
    gte.in[0] <== lhs;
    gte.in[1] <== rhs;

    gte.out === 1;
}

// levels=24 -> 2^24 = ~16M deposit slots
// ringSize=16 -> 16 collateral commitments from last 30 epochs
//
// Public inputs:  ring[16], nullifierHash, root, borrowed, minRatioBps
// Private inputs: secret, nullifier, denomination, pathElements[24], pathIndices[24], ring_index
component main {public [ring, nullifierHash, root, borrowed, minRatioBps]} = CollateralRing(24, 16);
