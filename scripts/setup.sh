#!/bin/bash
# =============================================================================
# ShieldLend Circuit Setup Script
# =============================================================================
# This script runs the full trusted setup for all 3 ShieldLend ZK circuits.
#
# What is a "trusted setup"?
#   Groth16 requires a two-phase ceremony:
#   Phase 1 (Powers of Tau): Generic setup — any circuit can reuse this.
#              The "toxic waste" is the randomness used. If the ceremony has
#              enough participants, it's safe even if some are malicious.
#   Phase 2 (Per-circuit): Circuit-specific zkey generation.
#              This binds the Phase 1 output to the specific R1CS of each circuit.
#
# Output files:
#   circuits/keys/deposit.zkey        → proving key (used by prover)
#   circuits/keys/withdraw.zkey       → proving key (used by prover)
#   circuits/keys/collateral.zkey     → proving key (used by prover)
#   circuits/keys/deposit_vkey.json   → verification key (used by verifier)
#   circuits/keys/withdraw_vkey.json  → verification key
#   circuits/keys/collateral_vkey.json→ verification key
#   contracts/src/verifiers/DepositVerifier.sol    → Solidity verifier
#   contracts/src/verifiers/WithdrawVerifier.sol   → Solidity verifier
#   contracts/src/verifiers/CollateralVerifier.sol → Solidity verifier
#
# IMPORTANT: In production, use a real Powers of Tau ceremony output.
#   The ceremony below uses snarkjs's own test ptau (NOT production-safe).
#   For production: download a ceremony with many participants from
#   https://github.com/iden3/snarkjs?tab=readme-ov-file#7-prepare-phase-2
# =============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CIRCUITS_DIR="$PROJECT_ROOT/circuits"
KEYS_DIR="$CIRCUITS_DIR/keys"
VERIFIERS_DIR="$PROJECT_ROOT/contracts/src/verifiers"
NODE_MODULES="$PROJECT_ROOT/node_modules"

mkdir -p "$KEYS_DIR" "$VERIFIERS_DIR"

echo "================================================"
echo "  ShieldLend ZK Circuit Setup"
echo "================================================"
echo ""

# =============================================================================
# Phase 1: Powers of Tau (reusable across all circuits)
# =============================================================================
PTAU_FILE="$KEYS_DIR/pot20_final.ptau"

if [ ! -f "$PTAU_FILE" ]; then
    echo "[Phase 1] Generating Powers of Tau (20 levels = 2^20 constraints max)..."
    echo "  Note: Using snarkjs new ceremony for local dev."
    echo "  For production: download a trusted ptau from Hermez/Iden3 ceremonies."
    echo ""

    # Start ceremony (power=20 → supports up to 2^20 = ~1M constraints)
    npx snarkjs powersoftau new bn128 20 "$KEYS_DIR/pot20_0000.ptau" -v

    # Contribute entropy (in production: multiple independent contributors)
    echo "test-entropy-shieldlend-local-$(date +%s)" | \
        npx snarkjs powersoftau contribute "$KEYS_DIR/pot20_0000.ptau" "$KEYS_DIR/pot20_0001.ptau" \
        --name="ShieldLend Local Dev" -v -e="$(date +%s%N)"

    # Prepare for Phase 2
    npx snarkjs powersoftau prepare phase2 "$KEYS_DIR/pot20_0001.ptau" "$PTAU_FILE" -v

    echo "[Phase 1] Done. ptau file: $PTAU_FILE"
    echo ""
else
    echo "[Phase 1] Reusing existing ptau: $PTAU_FILE"
    echo ""
fi

# =============================================================================
# Helper: Compile + setup a single circuit
# =============================================================================
setup_circuit() {
    local name=$1      # e.g. "deposit"
    local circom_file="$CIRCUITS_DIR/${name}.circom"

    echo "──────────────────────────────────────────────"
    echo "  Circuit: ${name}.circom"
    echo "──────────────────────────────────────────────"

    # Step 1: Compile Circom → R1CS + WASM witness generator
    echo "[1/5] Compiling ${name}.circom..."
    circom "$circom_file" \
        --r1cs "$KEYS_DIR/${name}.r1cs" \
        --wasm --output "$KEYS_DIR" \
        --sym "$KEYS_DIR/${name}.sym" \
        -l "$NODE_MODULES" \
        -O2

    echo "      R1CS: $KEYS_DIR/${name}.r1cs"
    echo "      WASM: $KEYS_DIR/${name}_js/${name}.wasm"

    # Step 2: Print circuit stats (number of constraints, etc.)
    echo "[2/5] Circuit info:"
    npx snarkjs r1cs info "$KEYS_DIR/${name}.r1cs"

    # Step 3: Phase 2 — circuit-specific zkey
    echo "[3/5] Generating ${name}.zkey (circuit-specific proving key)..."
    npx snarkjs groth16 setup "$KEYS_DIR/${name}.r1cs" "$PTAU_FILE" "$KEYS_DIR/${name}_0000.zkey"

    # Contribute to Phase 2 ceremony (in production: more contributors + beacon)
    echo "shieldlend-${name}-$(date +%s%N)" | \
        npx snarkjs zkey contribute "$KEYS_DIR/${name}_0000.zkey" "$KEYS_DIR/${name}.zkey" \
        --name="ShieldLend ${name} setup" -v -e="$(date +%s%N)"

    echo "[4/5] Exporting verification key for ${name}..."
    npx snarkjs zkey export verificationkey "$KEYS_DIR/${name}.zkey" "$KEYS_DIR/${name}_vkey.json"

    echo "[5/5] Generating Solidity verifier for ${name}..."
    local verifier_out="$VERIFIERS_DIR/$(echo $name | sed 's/.*/\u&/')Verifier.sol"
    npx snarkjs zkey export solidityverifier "$KEYS_DIR/${name}.zkey" "$verifier_out"

    echo "      Verifier: $verifier_out"
    echo "  ✓ ${name} setup complete"
    echo ""
}

# =============================================================================
# Phase 2: Per-circuit setup
# =============================================================================
echo ""
echo "[Phase 2] Running per-circuit setup for all 3 circuits..."
echo ""

setup_circuit "deposit"
setup_circuit "withdraw"
setup_circuit "collateral"

echo "================================================"
echo "  All circuits ready!"
echo ""
echo "  Proving keys:      circuits/keys/*.zkey"
echo "  Verification keys: circuits/keys/*_vkey.json"
echo "  WASM witnesses:    circuits/keys/*_js/*.wasm"
echo "  Solidity verifiers:contracts/src/verifiers/*.sol"
echo ""
echo "  Next step:"
echo "    forge build (compile contracts)"
echo "    forge test  (run unit tests)"
echo "    forge script contracts/script/Deploy.s.sol (deploy)"
echo "================================================"
