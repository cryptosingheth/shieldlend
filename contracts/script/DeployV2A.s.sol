// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {LendingPool} from "../src/LendingPool.sol";

/**
 * DeployV2A — full deploy: NullifierRegistry + LendingPool + 5 ShieldedPool shards
 *
 * All three contract types are redeployed together so the security fixes in
 * LendingPool (settleCollateral guards, pushRoot validation, nextLoanId=1,
 * repay unlockNullifier, reentrancy guards) are live on-chain.
 *
 * Prerequisites (already deployed, not touched):
 *   PoseidonT3:             0x30F4D804AF57f405ba427dF1f90fd950C27c1Cc8
 *   ZkVerifyAggregation:    0x8b722840538D9101bFd8c1c228fB704Fbe47f460
 *
 * Run:
 *   DEPLOYER_PRIVATE_KEY=... forge script script/DeployV2A.s.sol \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast \
 *     --libraries lib/poseidon-solidity/contracts/PoseidonT3.sol:PoseidonT3:0x30F4D804AF57f405ba427dF1f90fd950C27c1Cc8
 */
contract DeployV2A is Script {
    address constant ZK_VERIFY = 0x8b722840538D9101bFd8c1c228fB704Fbe47f460;
    bytes32 constant VK_HASH   = 0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Deploy NullifierRegistry V2A (multi-shard)
        NullifierRegistry nullifierReg = new NullifierRegistry(deployer);
        console.log("NullifierRegistry V2A:", address(nullifierReg));

        // 2. Deploy LendingPool V2A (all security fixes: settleCollateral guards,
        //    pushRoot validation, nextLoanId=1, repay unlockNullifier, reentrancy guards)
        LendingPool lendingPool = new LendingPool(address(nullifierReg));
        console.log("LendingPool V2A:", address(lendingPool));

        // 3. Deploy 5 ShieldedPool shards, each linked to the new LendingPool
        address[5] memory shards;
        for (uint256 i = 0; i < 5; i++) {
            ShieldedPool shard = new ShieldedPool{salt: bytes32(i + 100)}(
                address(nullifierReg),
                ZK_VERIFY,
                VK_HASH,
                deployer
            );
            shard.setLendingPool(address(lendingPool));
            shards[i] = address(shard);
            console.log("Shard", i + 1, ":", address(shard));
        }

        // 4. Register all shards with NullifierRegistry
        for (uint256 i = 0; i < 5; i++) {
            nullifierReg.registerShard(shards[i]);
        }
        console.log("All shards registered with NullifierRegistry");

        // 5. Register all shards with LendingPool
        address[] memory shardList = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            shardList[i] = shards[i];
        }
        lendingPool.registerShards(shardList);
        // Also set shard 1 as the default for backwards-compatible 4-param borrow()
        lendingPool.setShieldedPool(shards[0]);
        console.log("All shards registered with LendingPool");

        vm.stopBroadcast();

        // Print summary for .env.local update
        console.log("\n=== Update .env.local with: ===");
        console.log("NEXT_PUBLIC_NULLIFIER_REGISTRY_ADDRESS=", address(nullifierReg));
        console.log("NEXT_PUBLIC_LENDING_POOL_ADDRESS=", address(lendingPool));
        for (uint256 i = 0; i < 5; i++) {
            console.log("NEXT_PUBLIC_SHARD_", i + 1, "=", shards[i]);
        }
        console.log("NEXT_PUBLIC_SHIELDED_POOL_ADDRESS=", shards[0]);
    }
}
