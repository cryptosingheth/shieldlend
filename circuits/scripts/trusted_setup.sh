#!/usr/bin/env bash
# trusted_setup.sh — ShieldLend V2 Groth16 Trusted Setup
# =========================================================
# Run this script ONCE after compiling the V2 circuits to:
#   1. Compile each circom file to R1CS + WASM
#   2. Run the Powers-of-Tau ceremony (or reuse an existing ptau file)
#   3. Run circuit-specific phase 2 (zkey generate + contribute)
#   4. Export verification keys (vkey.json) and Solidity verifiers
#   5. Compute on-chain VK hashes for deployment
#
# Prerequisites:
#   npm install -g circom snarkjs
#   node >= 18
#
# Usage:
#   cd /path/to/shieldlend-v2/circuits
#   chmod +x scripts/trusted_setup.sh
#   ./scripts/trusted_setup.sh
#
# Output (in circuits/keys/):
#   withdraw_ring_vkey.json
#   collateral_ring_vkey.json
#   withdraw_ring.zkey
#   collateral_ring.zkey
#   WithdrawRingVerifier.sol   (informational — V2 uses zkVerify instead)
#   CollateralRingVerifier.sol (informational — V2 uses zkVerify instead)

set -euo pipefail

CIRCUITS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="$CIRCUITS_DIR/keys"
BUILD_DIR="$CIRCUITS_DIR/build"

mkdir -p "$KEYS_DIR" "$BUILD_DIR"

# ── 0. Powers of Tau ──────────────────────────────────────────────────────────
# WithdrawRing(24, 16) has ~32K constraints; CollateralRing adds ~5K more.
# 2^17 = 131,072 — safe upper bound. Use ptau_17_final.ptau.
PTAU_FILE="$KEYS_DIR/pot17_final.ptau"

if [ ! -f "$PTAU_FILE" ]; then
  echo "Downloading Powers of Tau (2^17, Hermez)..."
  curl -L -o "$PTAU_FILE" \
    "https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_17.ptau"
  echo "Downloaded ptau file."
else
  echo "Using existing ptau file: $PTAU_FILE"
fi

# ── 1. Compile circuits ───────────────────────────────────────────────────────
echo ""
echo "==> Compiling withdraw_ring.circom ..."
circom "$CIRCUITS_DIR/withdraw_ring.circom" \
  --r1cs --wasm --sym \
  -o "$BUILD_DIR" \
  -l "$CIRCUITS_DIR/node_modules"

echo "==> Compiling collateral_ring.circom ..."
circom "$CIRCUITS_DIR/collateral_ring.circom" \
  --r1cs --wasm --sym \
  -o "$BUILD_DIR" \
  -l "$CIRCUITS_DIR/node_modules"

# ── 2. Phase 2 setup — withdraw_ring ─────────────────────────────────────────
echo ""
echo "==> Phase 2 setup: withdraw_ring ..."
WITHDRAW_ZKEY0="$BUILD_DIR/withdraw_ring_0.zkey"
WITHDRAW_ZKEY="$KEYS_DIR/withdraw_ring.zkey"

snarkjs groth16 setup \
  "$BUILD_DIR/withdraw_ring.r1cs" \
  "$PTAU_FILE" \
  "$WITHDRAW_ZKEY0"

# Contribute randomness to the ceremony (use a fixed entropy string for CI;
# replace with an interactive contribution in production):
echo "ShieldLend-withdraw-ring-contribution-$(date +%s)" | \
  snarkjs zkey contribute \
  "$WITHDRAW_ZKEY0" \
  "$WITHDRAW_ZKEY" \
  --name="ShieldLend V2 withdraw_ring" \
  -v

snarkjs zkey export verificationkey \
  "$WITHDRAW_ZKEY" \
  "$KEYS_DIR/withdraw_ring_vkey.json"

snarkjs zkey export solidityverifier \
  "$WITHDRAW_ZKEY" \
  "$KEYS_DIR/WithdrawRingVerifier.sol"

echo "withdraw_ring vkey exported to: $KEYS_DIR/withdraw_ring_vkey.json"

# ── 3. Phase 2 setup — collateral_ring ───────────────────────────────────────
echo ""
echo "==> Phase 2 setup: collateral_ring ..."
COLLATERAL_ZKEY0="$BUILD_DIR/collateral_ring_0.zkey"
COLLATERAL_ZKEY="$KEYS_DIR/collateral_ring.zkey"

snarkjs groth16 setup \
  "$BUILD_DIR/collateral_ring.r1cs" \
  "$PTAU_FILE" \
  "$COLLATERAL_ZKEY0"

echo "ShieldLend-collateral-ring-contribution-$(date +%s)" | \
  snarkjs zkey contribute \
  "$COLLATERAL_ZKEY0" \
  "$COLLATERAL_ZKEY" \
  --name="ShieldLend V2 collateral_ring" \
  -v

snarkjs zkey export verificationkey \
  "$COLLATERAL_ZKEY" \
  "$KEYS_DIR/collateral_ring_vkey.json"

snarkjs zkey export solidityverifier \
  "$COLLATERAL_ZKEY" \
  "$KEYS_DIR/CollateralRingVerifier.sol"

echo "collateral_ring vkey exported to: $KEYS_DIR/collateral_ring_vkey.json"

# ── 4. Compute on-chain VK hashes ────────────────────────────────────────────
echo ""
echo "==> Computing VK hashes for Deploy.s.sol ..."
node - <<'JSEOF'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const keysDir = path.join(__dirname, "..", "keys");

for (const circuit of ["withdraw_ring"]) {
  const vkey = JSON.parse(fs.readFileSync(path.join(keysDir, `${circuit}_vkey.json`), "utf8"));
  // Hash the canonical JSON representation (sorted keys for determinism)
  const hash = "0x" + crypto
    .createHash("keccak256")
    .update(JSON.stringify(vkey, Object.keys(vkey).sort()))
    .digest("hex");
  console.log(`\nWITHDRAW_RING_VK_HASH (for Deploy.s.sol):`);
  console.log(`  ${hash}`);
  console.log(`\nSet this in your .env:`);
  console.log(`  WITHDRAW_RING_VK_HASH=${hash}`);
}
JSEOF

# ── 5. Summary ───────────────────────────────────────────────────────────────
echo ""
echo "======================================================================"
echo "Trusted setup complete."
echo ""
echo "Files in $KEYS_DIR:"
ls -lh "$KEYS_DIR"
echo ""
echo "Next steps:"
echo "  1. Copy WITHDRAW_RING_VK_HASH from above into contracts/.env"
echo "  2. Run: cd contracts && forge script script/Deploy.s.sol --broadcast"
echo "  3. Copy deployed addresses into frontend/.env.local"
echo "  4. Move withdraw_ring_vkey.json + collateral_ring_vkey.json to:"
echo "     frontend/../circuits/keys/ (already there)"
echo "======================================================================"
