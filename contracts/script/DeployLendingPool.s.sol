// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LendingPool} from "../src/LendingPool.sol";

contract DeployLendingPool is Script {
    function run() external {
        address nullifierRegistry = 0xD0e7D0A083544144a4EFf2ADAa6318E3a28722e7;
        vm.startBroadcast();
        LendingPool pool = new LendingPool(nullifierRegistry);
        console.log("LendingPool deployed at:", address(pool));
        vm.stopBroadcast();
    }
}
