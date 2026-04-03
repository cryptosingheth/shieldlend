// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {ZkVerifyAggregation} from "../src/ZkVerifyAggregation.sol";
import {LendingPool} from "../src/LendingPool.sol";

/*
 * ShieldLend V2 Deployment Script
 *
 * Deployment order:
 *   1. Deploy NullifierRegistry (with zero pool address)
 *   2. Deploy ZkVerifyAggregation (or use existing from env)
 *   3. Deploy ShieldedPool (LEVELS=24, epoch batching, denomination validation)
 *   4. Wire NullifierRegistry -> ShieldedPool
 *   5. Deploy LendingPool (accounting-only, no ETH custody)
 *   6. Wire ShieldedPool <-> LendingPool (bidirectional)
 *
 * V2 changes vs V1:
 *   - CollateralVerifier removed (collateral proof verified via zkVerify off-chain)
 *   - ShieldedPool.setLendingPool() called after LendingPool deploy
 *   - LendingPool.setShieldedPool() called after LendingPool deploy
 *   - vkHash env var is WITHDRAW_RING_VK_HASH (new ring circuit for V2)
 *     Replace bytes32(0) placeholder once V2 circuit trusted setup is complete:
 *       node -e "const c=require('crypto'),f=require('fs'),
 *         v=JSON.parse(f.readFileSync('circuits/keys/withdraw_ring_vkey.json'));
 *         console.log('0x'+c.createHash('sha256')
 *           .update(JSON.stringify(v,Object.keys(v).sort())).digest('hex'))"
 *
 * Usage:
 *   # Local Anvil
 *   forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 *
 *   # Base Sepolia
 *   forge script contracts/script/Deploy.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL \
 *     --private-key $PRIVATE_KEY \
 *     --broadcast --verify
 */
contract Deploy is Script {
    // Set ZKVERIFY_AGGREGATION env to use an existing deployment.
    // If address(0), a local ZkVerifyAggregation is deployed (operator=deployer) for Anvil/dev.
    address constant ZKVERIFY_AGGREGATION_DEFAULT = address(0);

    function run() external {
        uint256 deployerPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying ShieldLend V2...");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerPrivateKey);

        // 1. NullifierRegistry (zero pool address, set in step 4)
        NullifierRegistry nullifierRegistry = new NullifierRegistry(address(0));
        console.log("NullifierRegistry:", address(nullifierRegistry));

        // 2. zkVerify aggregation
        address zkAgg = vm.envOr("ZKVERIFY_AGGREGATION", ZKVERIFY_AGGREGATION_DEFAULT);
        if (zkAgg == address(0)) {
            zkAgg = address(new ZkVerifyAggregation(deployer));
            console.log("ZkVerifyAggregation (local):", zkAgg);
        } else {
            console.log("ZkVerifyAggregation (configured):", zkAgg);
        }

        // V2 withdraw_ring circuit verification key hash.
        // bytes32(0) placeholder until trusted setup is complete.
        bytes32 withdrawVkHash = bytes32(vm.envOr("WITHDRAW_RING_VK_HASH", bytes32(0)));

        // 3. ShieldedPool (LEVELS=24, epoch batching, denomination validation)
        ShieldedPool shieldedPool = new ShieldedPool(
            address(nullifierRegistry),
            zkAgg,
            withdrawVkHash
        );
        console.log("ShieldedPool:", address(shieldedPool));

        // 4. Wire NullifierRegistry -> ShieldedPool
        nullifierRegistry.setShieldedPool(address(shieldedPool));

        // 5. LendingPool (V2: accounting-only, no ETH custody, no CollateralVerifier)
        LendingPool lendingPool = new LendingPool(address(nullifierRegistry));
        console.log("LendingPool:", address(lendingPool));

        // 6. Wire ShieldedPool <-> LendingPool (bidirectional)
        shieldedPool.setLendingPool(address(lendingPool));
        lendingPool.setShieldedPool(address(shieldedPool));

        vm.stopBroadcast();

        console.log("\n=== ShieldLend V2 Deployment Summary ===");
        console.log("Network:           ", _getNetworkName());
        console.log("NullifierRegistry: ", address(nullifierRegistry));
        console.log("ShieldedPool:      ", address(shieldedPool));
        console.log("LendingPool:       ", address(lendingPool));
        console.log("");
        console.log("Next steps:");
        console.log("1. Set NEXT_PUBLIC_SHIELDED_POOL_ADDRESS in frontend/.env.local");
        console.log("2. Set NEXT_PUBLIC_LENDING_POOL_ADDRESS in frontend/.env.local");
        console.log("3. Set WITHDRAW_RING_VK_HASH once V2 circuit trusted setup is done");
        console.log("4. Set ZKVERIFY_SEED_PHRASE in frontend/.env.local for proof submission");
    }

    function _getNetworkName() internal view returns (string memory) {
        uint256 chainId = block.chainid;
        if (chainId == 1) return "Ethereum Mainnet";
        if (chainId == 11155111) return "Sepolia";
        if (chainId == 84532) return "Base Sepolia";
        if (chainId == 31337) return "Anvil (local)";
        return "Unknown";
    }
}
