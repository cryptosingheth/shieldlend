pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/comparators.circom";

/*
 * Collateral Range Proof Circuit — ShieldLend
 *
 * Proves that a borrower's collateral satisfies the minimum collateral ratio
 * WITHOUT revealing the exact collateral amount.
 *
 * Use case:
 *   A borrower wants to take a loan of `borrowed` tokens.
 *   The protocol requires collateral >= (ratio / 10000) * borrowed
 *   e.g., ratio = 15000 means 150% collateralization (LTV = 66.6%)
 *
 *   The borrower proves they have sufficient collateral privately.
 *   The verifier (on-chain contract) only sees: borrowed, ratio, and "proof valid".
 *   The exact collateral amount is never revealed.
 *
 * Revision note — Range proofs in ZK:
 *   Circom's comparators.circom provides LessThan(n) and GreaterEqualThan(n) templates.
 *   These work on n-bit numbers (e.g., n=64 for values up to 2^64).
 *   The constraint enforces: collateral * 10000 >= ratio * borrowed
 *   We scale by 10000 to avoid fractions (Circom works in integer arithmetic).
 *
 * Example:
 *   borrowed = 1000 USDC, ratio = 15000 (150%), collateral = 1600 ETH (in USD terms)
 *   Check: 1600 * 10000 = 16,000,000 >= 15000 * 1000 = 15,000,000 ✓
 *
 * Security note:
 *   The n parameter for comparators must be large enough for your token amounts.
 *   With n=64, max value is ~1.8 * 10^19 (fine for any realistic DeFi amounts).
 *   The intermediate product `collateral * 10000` must fit in 64 bits too.
 *   For large collateral values, use n=96 to be safe.
 */
template CollateralCheck(n) {
    // ── Private inputs ──────────────────────────────────────────────────────
    signal input collateral; // exact collateral amount (in smallest token units) — NEVER revealed

    // ── Public inputs ────────────────────────────────────────────────────────
    signal input borrowed;   // loan amount (in smallest token units) — known on-chain
    signal input ratio;      // minimum collateral ratio * 10000 (e.g., 15000 = 150%)

    // ── Constraint: collateral * 10000 >= ratio * borrowed ───────────────────
    // Rewrite as: ratio * borrowed <= collateral * 10000
    // We use GreaterEqualThan: checks left >= right

    // Compute both sides as intermediate signals (quadratic, one multiplication each)
    signal lhs;
    signal rhs;
    lhs <== collateral * 10000;   // left-hand side: scaled collateral
    rhs <== ratio * borrowed;     // right-hand side: minimum required

    // GreaterEqualThan(n) outputs 1 if lhs >= rhs, 0 otherwise
    // We add a constraint that the output MUST be 1 (proof fails if not satisfied)
    component gte = GreaterEqThan(n);
    gte.in[0] <== lhs;
    gte.in[1] <== rhs;

    // This constraint makes the proof invalid if collateral is insufficient.
    // The prover CANNOT generate a valid proof if gte.out == 0.
    gte.out === 1;
}

// n=96 bits — handles collateral * 10000 up to ~7.9 * 10^28 (safe for any DeFi amounts)
// Public inputs: borrowed, ratio
// Private inputs: collateral
component main {public [borrowed, ratio]} = CollateralCheck(96);
