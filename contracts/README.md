# contracts/

Solidity smart contracts for ShieldLend V2A. Built and tested with Foundry.

## Deployed Contracts — Base Sepolia (Chain ID 84532)

| Contract | Address |
|---------|---------|
| `ShieldedPool` | `0xfaeD6bf64a513aCEC9E8f1672d5e6584F869661a` |
| `LendingPool` | `0xdBc459EC670deE0ae70cbF8b9Ea43a00b7A9184D` |
| `NullifierRegistry` | `0x685E69Fa36521f527C00E05cf3e18eE4d18aD10C` |
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

# Test (114 tests)
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
