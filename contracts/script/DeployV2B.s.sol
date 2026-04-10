// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {LendingPool} from "../src/LendingPool.sol";

/**
 * DeployV2B — full deploy: NullifierRegistry + LendingPool + 5 ShieldedPool shards
 *
 * V2B changes vs V2A:
 *   - ShieldedPool.withdraw(): global hasActiveLoan check (cross-shard collateral settle)
 *   - LendingPool.settleCollateral(): removed same-shard restriction; unlocks collateral
 *     on the correct shard regardless of which shard calls settle
 *   - Result: deposit → shard X, withdraw → random shard Y; full cross-shard routing
 *
 * Prerequisites (already deployed, not touched):
 *   PoseidonT3:             0x30F4D804AF57f405ba427dF1f90fd950C27c1Cc8
 *   ZkVerifyAggregation:    0x8b722840538D9101bFd8c1c228fB704Fbe47f460
 *
 * Run:
 *   DEPLOYER_PRIVATE_KEY=... forge script script/DeployV2B.s.sol \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast \
 *     --libraries lib/poseidon-solidity/contracts/PoseidonT3.sol:PoseidonT3:0x30F4D804AF57f405ba427dF1f90fd950C27c1Cc8
 */
contract DeployV2B is Script {
    address constant ZK_VERIFY = 0x8b722840538D9101bFd8c1c228fB704Fbe47f460;
    bytes32 constant VK_HASH   = 0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. NullifierRegistry
        NullifierRegistry nullifierReg = new NullifierRegistry(deployer);
        console.log("NullifierRegistry V2B:", address(nullifierReg));

        // 2. LendingPool (V2B: cross-shard settleCollateral)
        LendingPool lendingPool = new LendingPool(address(nullifierReg));
        console.log("LendingPool V2B:", address(lendingPool));

        // 3. Deploy 5 ShieldedPool shards (V2B: global hasActiveLoan check in withdraw)
        //    salt = i+200 to avoid CREATE2 collision with V2A (i+100) and V2 (i+0)
        address[5] memory shards;
        for (uint256 i = 0; i < 5; i++) {
            ShieldedPool shard = new ShieldedPool{salt: bytes32(i + 200)}(
                address(nullifierReg),
                ZK_VERIFY,
                VK_HASH,
                deployer
            );
            shard.setLendingPool(address(lendingPool));
            shards[i] = address(shard);
            console.log("Shard", i + 1, ":", address(shard));
        }

        // 4. Register shards with NullifierRegistry
        for (uint256 i = 0; i < 5; i++) {
            nullifierReg.registerShard(shards[i]);
        }

        // 5. Register shards with LendingPool
        address[] memory shardList = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            shardList[i] = shards[i];
        }
        lendingPool.registerShards(shardList);
        lendingPool.setShieldedPool(shards[0]);

        vm.stopBroadcast();

        console.log("\n=== Update .env.local with: ===");
        console.log("NEXT_PUBLIC_NULLIFIER_REGISTRY_ADDRESS=", address(nullifierReg));
        console.log("NEXT_PUBLIC_LENDING_POOL_ADDRESS=", address(lendingPool));
        for (uint256 i = 0; i < 5; i++) {
            console.log("NEXT_PUBLIC_SHARD_", i + 1, "=", shards[i]);
        }
        console.log("NEXT_PUBLIC_SHIELDED_POOL_ADDRESS=", shards[0]);
    }
}
