# contracts/

Solidity smart contracts for ShieldLend V2A. Built and tested with Foundry.

## Deployed Contracts — Base Sepolia (Chain ID 84532)

| Contract | Address | Version |
|---------|---------|---------|
| `ShieldedPool` — Shard 1 | `0xa99F12A4340A47FD3075Ae0352Fca77b13bF0d61` | V2A final — all audit findings resolved |
| `ShieldedPool` — Shard 2 | `0x7488f4f7Ae7A98e1C7B3815C310404f7bFDc2203` | V2A final |
| `ShieldedPool` — Shard 3 | `0xf859Ab35bC212dc2bBC90DF8d86Ff36243b698d8` | V2A final |
| `ShieldedPool` — Shard 4 | `0x5F9298DaeB820dC40AF9C8cf2a9B339a111b52Ea` | V2A final |
| `ShieldedPool` — Shard 5 | `0x1a1070AcB0542F9A39E18b32151A18dF97Eaf3E4` | V2A final |
| `LendingPool` | `0x1Ff7FD0bdF660c82158729A9c74F6DD6F6f2988d` | V2A final — settleCollateral ETH forwarding, pushRoot validation, nextLoanId=1 |
| `NullifierRegistry` | `0xe7B4C2B6ae962EFFCDc9797c5E23E592275ac411` | V2A — multi-shard, registerShard() |
| `PoseidonT3` (library) | `0x30F4D804AF57f405ba427dF1f90fd950C27c1Cc8` | Linked into all shards (unchanged) |
| `ZkVerifyAggregation` | `0x8b722840538D9101bFd8c1c228fB704Fbe47f460` | V2 (unchanged) |

## Source Files

| File | Description |
|------|-------------|
| `src/ShieldedPool.sol` | Main vault — incremental Merkle tree (LEVELS=24), epoch batching, flush, ring-based withdraw, collateral lock/unlock |
| `src/LendingPool.sol` | Accounting-only lending — Aave v3 two-slope interest, borrow/repay, health factor, liquidation |
| `src/NullifierRegistry.sol` | Tracks spent nullifiers to prevent double-withdrawal |
| `src/ShieldedPoolFactory.sol` | Feature E: deploys 5 CREATE2 shards; blast-radius isolation |
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
