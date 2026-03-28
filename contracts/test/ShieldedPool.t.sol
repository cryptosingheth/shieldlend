// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";

/*
 * ShieldedPool Tests
 *
 * These tests verify the core mechanics WITHOUT ZK proofs.
 * The actual ZK proof verification is mocked (always returns true)
 * because we test the circuit separately via snarkjs.
 *
 * Revision note — Foundry testing pattern:
 *   - setUp() runs before each test
 *   - vm.prank(addr) makes the next call come from addr
 *   - vm.deal(addr, amount) gives ETH to an address
 *   - vm.expectRevert() expects the next call to revert
 *   - console.log() prints to terminal during tests
 */
contract ShieldedPoolTest is Test {
    ShieldedPool pool;
    NullifierRegistry nullifierReg;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant COMMITMENT_1 = bytes32(uint256(0x1));
    bytes32 constant COMMITMENT_2 = bytes32(uint256(0x2));
    bytes32 constant NULLIFIER_HASH_1 = bytes32(uint256(0xABCD));

    function setUp() public {
        // Deploy contracts (pool address used as its own nullifier registry in test)
        // In production: deploy NullifierRegistry first, then ShieldedPool
        pool = new ShieldedPool(address(0), address(0)); // placeholder addresses
        nullifierReg = new NullifierRegistry(address(pool));

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ── Deposit tests ────────────────────────────────────────────────────────

    function test_deposit_insertsCommitmentIntoTree() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT_1);

        assertEq(pool.nextIndex(), 1);
        console.log("Root after deposit:", uint256(pool.getLastRoot()));
    }

    function test_deposit_emitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ShieldedPool.Deposit(COMMITMENT_1, 0, block.timestamp, 1 ether);
        pool.deposit{value: 1 ether}(COMMITMENT_1);
    }

    function test_deposit_reverts_withZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.InvalidAmount.selector);
        pool.deposit{value: 0}(COMMITMENT_1);
    }

    function test_multipleDeposits_updateRoot() public {
        vm.startPrank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT_1);
        bytes32 root1 = pool.getLastRoot();

        pool.deposit{value: 1 ether}(COMMITMENT_2);
        bytes32 root2 = pool.getLastRoot();
        vm.stopPrank();

        // Root changes with each deposit
        assertTrue(root1 != root2, "Root should change with each deposit");
        assertEq(pool.nextIndex(), 2);
    }

    function test_rootHistory_isKnown() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();
        assertTrue(pool.isKnownRoot(root), "Root should be in history");
    }

    // ── Nullifier registry tests ─────────────────────────────────────────────

    function test_nullifier_notSpentInitially() public view {
        assertFalse(nullifierReg.isSpent(NULLIFIER_HASH_1));
    }

    function test_nullifier_unauthorizedMark_reverts() public {
        vm.prank(alice); // alice is not the pool
        vm.expectRevert(NullifierRegistry.Unauthorized.selector);
        nullifierReg.markSpent(NULLIFIER_HASH_1);
    }

    // ── Incremental Merkle tree correctness ──────────────────────────────────

    function test_treeLevel_incrementsCorrectly() public {
        uint256 depositsToMake = 8;
        for (uint256 i = 0; i < depositsToMake; i++) {
            vm.prank(alice);
            pool.deposit{value: 0.1 ether}(bytes32(i + 1));
        }
        assertEq(pool.nextIndex(), depositsToMake);
        console.log("Final root after 8 deposits:", uint256(pool.getLastRoot()));
    }

    // ── Fuzz test ────────────────────────────────────────────────────────────

    function testFuzz_deposit_anyAmount(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(alice, amount);
        vm.prank(alice);
        pool.deposit{value: amount}(COMMITMENT_1);
        assertEq(pool.nextIndex(), 1);
    }
}
