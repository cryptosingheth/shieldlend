// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldedPool} from "./ShieldedPool.sol";

/*
 * ShieldedPoolFactory — ShieldLend V2A
 *
 * Deploys N ShieldedPool shards via CREATE2, each at a deterministic but
 * distinct address. Reduces per-exploit blast radius: one shard drained
 * → at most 1/N of TVL at risk, others unaffected.
 *
 * Privacy bonus: deposits and withdrawals can target different shard addresses,
 * making protocol identification harder on-chain (pattern copied from Tornado Cash).
 *
 * Security fix (HIGH-4): factory now registers all shards with NullifierRegistry
 * and LendingPool in the constructor — no manual post-deploy step required.
 * Without registration, withdrawals revert (markSpent → NotRegisteredShard)
 * and all user funds would be locked until admin intervened.
 */

interface INullifierRegistryAdmin {
    function registerShard(address shard) external;
}

interface ILendingPoolAdmin {
    function registerShards(address[] calldata shardList) external;
    function setShieldedPool(address shard) external;
}

contract ShieldedPoolFactory {
    uint256 public constant NUM_SHARDS = 5;

    address[NUM_SHARDS] public shards;
    address public immutable admin;
    address public immutable lendingPool;

    event ShardDeployed(uint256 indexed shardIndex, address shard);

    constructor(
        address _lendingPool,
        address _nullifierRegistry,
        address _zkVerifyAggregation,
        bytes32 _vkHash
    ) {
        admin = msg.sender;
        lendingPool = _lendingPool;

        for (uint256 i = 0; i < NUM_SHARDS; i++) {
            ShieldedPool shard = new ShieldedPool{salt: bytes32(i)}(
                _nullifierRegistry,
                _zkVerifyAggregation,
                _vkHash,
                msg.sender  // factory deployer becomes each shard's admin
            );
            shard.setLendingPool(_lendingPool);
            shards[i] = address(shard);

            // Register with NullifierRegistry immediately — markSpent() will revert
            // for any unregistered shard, making withdrawals permanently DOA without this.
            INullifierRegistryAdmin(_nullifierRegistry).registerShard(address(shard));

            emit ShardDeployed(i, address(shard));
        }

        // Register all shards with LendingPool (batch call for efficiency)
        address[] memory shardList = new address[](NUM_SHARDS);
        for (uint256 i = 0; i < NUM_SHARDS; i++) {
            shardList[i] = shards[i];
        }
        ILendingPoolAdmin(_lendingPool).registerShards(shardList);
        // Set shard 0 as the default for backwards-compatible 4-param borrow()
        ILendingPoolAdmin(_lendingPool).setShieldedPool(shards[0]);
    }

    /// @notice Returns all shard addresses.
    function getShards() external view returns (address[NUM_SHARDS] memory) {
        return shards;
    }
}
