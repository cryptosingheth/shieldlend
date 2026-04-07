# contracts/

Solidity smart contracts for ShieldLend V2A. Built and tested with Foundry.

## Deployed Contracts — Base Sepolia (Chain ID 84532)

| Contract | Address |
|---------|---------|
| `ShieldedPool` | `0xdd477c9Abe05a66741D28bae57B4b1eD484232E7` |
| `LendingPool` | `0x456Ad285F2E12Adc2dAe8e14Bb0b0229c906f959` |
| `NullifierRegistry` | `0xd696a77dB8C8289f97CE0d558A612809E71049C7` |
| `ZkVerifyAggregation` | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` |

## Source Files

| File | Description |
|------|-------------|
| `src/ShieldedPool.sol` | Main vault — incremental Merkle tree (LEVELS=24), epoch batching, flush, ring-based withdraw, collateral lock/unlock |
| `src/LendingPool.sol` | Accounting-only lending — Aave v3 two-slope interest, borrow/repay, health factor, liquidation |
| `src/NullifierRegistry.sol` | Tracks spent nullifiers to prevent double-withdrawal |
| `src/ZkVerifyAggregation.sol` | On-chain aggregation root storage; `submitAggregation()` + `verifyProofAggregation()` |

## Commands

```bash
# Build
forge build

# Test (117 tests)
forge test

# Test with verbosity
forge test -vvvv

# Deploy
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

## Environment Variables

```bash
RPC_URL=<Base Sepolia RPC — e.g. https://sepolia.base.org>
PRIVATE_KEY=<deployer private key>
```

See [`docs/architecture.md`](../docs/architecture.md) for full contract interface definitions.
