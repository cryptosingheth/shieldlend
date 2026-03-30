// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";

/// @dev Unit tests for initializer, access control, and double-spend protection.
contract NullifierRegistryTest is Test {
    address admin;
    address alice = makeAddr("alice");
    address pool = makeAddr("pool");

    function setUp() public {
        admin = address(this);
    }

    function test_constructor_setsAdminAndPlaceholderPool() public {
        NullifierRegistry reg = new NullifierRegistry(address(0));
        assertEq(reg.admin(), admin);
        assertEq(reg.shieldedPool(), address(0));
    }

    function test_setShieldedPool_admin_succeeds() public {
        NullifierRegistry reg = new NullifierRegistry(address(0));
        reg.setShieldedPool(pool);
        assertEq(reg.shieldedPool(), pool);
    }

    function test_setShieldedPool_nonAdmin_reverts() public {
        NullifierRegistry reg = new NullifierRegistry(address(0));
        vm.prank(alice);
        vm.expectRevert(NullifierRegistry.Unauthorized.selector);
        reg.setShieldedPool(pool);
    }

    function test_setShieldedPool_secondCall_revertsAlreadyInitialized() public {
        NullifierRegistry reg = new NullifierRegistry(address(0));
        reg.setShieldedPool(pool);
        vm.expectRevert(NullifierRegistry.AlreadyInitialized.selector);
        reg.setShieldedPool(alice);
    }

    function test_markSpent_onlyPool() public {
        NullifierRegistry reg = new NullifierRegistry(address(0));
        reg.setShieldedPool(pool);
        bytes32 nh = bytes32(uint256(0x1111));

        vm.prank(alice);
        vm.expectRevert(NullifierRegistry.Unauthorized.selector);
        reg.markSpent(nh);
    }

    function test_markSpent_secondTime_revertsAlreadySpent() public {
        NullifierRegistry reg = new NullifierRegistry(address(0));
        reg.setShieldedPool(pool);
        bytes32 nh = bytes32(uint256(0x2222));

        vm.startPrank(pool);
        reg.markSpent(nh);
        vm.expectRevert(abi.encodeWithSelector(NullifierRegistry.AlreadySpent.selector, nh));
        reg.markSpent(nh);
        vm.stopPrank();
    }

    function test_isSpent_reflectsState() public {
        NullifierRegistry reg = new NullifierRegistry(address(0));
        reg.setShieldedPool(pool);
        bytes32 nh = bytes32(uint256(0x3333));

        assertFalse(reg.isSpent(nh));

        vm.prank(pool);
        reg.markSpent(nh);

        assertTrue(reg.isSpent(nh));
    }
}
