# contracts/

Solidity smart contracts for ShieldLend V2A. Built and tested with Foundry.

## Deployed Contracts — Base Sepolia (Chain ID 84532)

| Contract | Address |
|---------|---------|
| `ShieldedPool` | `0x9365e995F8aF1051db68100677a6C9cf225055A9` |
| `LendingPool` | `0x1aacF59792404b23287Faa9b0fbC3c9505cc56c9` |
| `NullifierRegistry` | `0xD0e7D0A083544144a4EFf2ADAa6318E3a28722e7` |
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
