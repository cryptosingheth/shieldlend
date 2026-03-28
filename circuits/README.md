# circuits/

ZK circuits written in Circom. All circuits compile to WebAssembly for browser-side proof generation.

## Planned Circuits

| File | Status | Description |
|------|--------|-------------|
| `deposit.circom` | 🔜 Step 2 | Pedersen commitment of (amount, secret, nullifier) |
| `withdraw.circom` | 🔜 Step 3 | Merkle membership proof + nullifier reveal |
| `collateral.circom` | 🔜 Step 9 | Range proof: collateral ≥ min_ratio × borrowed |

## Build

```bash
# Compile a circuit
circom deposit.circom --r1cs --wasm --sym -o build/

# Trusted setup (requires pot12_final.ptau)
snarkjs groth16 setup build/deposit.r1cs keys/pot12_final.ptau keys/deposit_0000.zkey

# Export verification key
snarkjs zkey export verificationkey keys/deposit_0000.zkey keys/deposit_vkey.json

# Export Solidity verifier
snarkjs zkey export solidityverifier keys/deposit_0000.zkey ../contracts/src/DepositVerifier.sol
```

See [`docs/circuits.md`](../docs/circuits.md) for full signal definitions and constraint derivations.
