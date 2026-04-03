// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console, Vm} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ZkVerifyAggregation} from "../src/ZkVerifyAggregation.sol";

/*
 * SecurityAudit.t.sol — Regression and exploit tests
 *
 * These tests verify three bugs found during the V2A audit are fixed:
 *
 * Bug 1 (CRITICAL): Auto-settle path bypassed ALL proof verification.
 *   Anyone observing a NullifierLocked event could call withdraw() with that
 *   nullifier and drain ETH without knowing the note secret.
 *   Fix: proof verification now runs BEFORE the auto-settle branch.
 *
 * Bug 2 (HIGH): Deposit event emitted queue index, not Merkle tree index.
 *   After Fisher-Yates shuffle + dummy insertions, the queue position differs
 *   from the final leaf position. Frontend can't build valid proofs.
 *   Fix: LeafInserted event emitted from _insert() with the real tree index.
 *
 * Bug 3 (HIGH): _dummiesForEpoch() used `nextIndex - epochNumber * DUMMIES_PER_EPOCH`
 *   which underflows once the adaptive dummy count drops below 10 per epoch.
 *   Fix: track totalDummiesInserted explicitly.
 */

/// @dev Mock LendingPool for auto-settle tests.
contract MockLP {
    uint256 public owedAmount;
    bool public settled;

    constructor(uint256 _owed) {
        owedAmount = _owed;
    }

    receive() external payable {}

    function getOwed(bytes32) external view returns (uint256) {
        return owedAmount;
    }

    function settleCollateral(bytes32) external payable {
        settled = true;
    }
}

contract SecurityAuditTest is Test {
    // Required for receiving ETH (flushEpoch tip)
    receive() external payable {}

    ShieldedPool pool;
    LendingPool lendingPool;
    NullifierRegistry nullifierReg;
    ZkVerifyAggregation zkVerify;

    address deployer;
    address alice = makeAddr("alice");
    address attacker = makeAddr("attacker");

    bytes32 constant VK_HASH = keccak256("withdraw_ring_vk_audit");
    bytes32 constant COMMITMENT = bytes32(uint256(0xBEEF));
    bytes32 constant NULLIFIER_HASH = bytes32(uint256(0xCAFE));
    uint256 constant DOMAIN_ID = 0;

    function setUp() public {
        deployer = address(this);
        zkVerify = new ZkVerifyAggregation(deployer);
        nullifierReg = new NullifierRegistry(address(0));
        pool = new ShieldedPool(address(nullifierReg), address(zkVerify), VK_HASH);
        nullifierReg.setShieldedPool(address(pool));

        vm.deal(alice, 100 ether);
        vm.deal(attacker, 100 ether);
        vm.deal(address(pool), 50 ether);
    }

    // =========================================================================
    // Bug 1: Auto-settle proof bypass
    // =========================================================================

    /// @notice CRITICAL: An attacker who has NO ZK proof should NOT be able to
    /// withdraw a locked note. Before the fix, the auto-settle branch skipped
    /// all proof verification — anyone could call withdraw() with a locked
    /// nullifier and drain ETH.
    function testBug1_autoSettle_requiresProof() public {
        MockLP mockLP = new MockLP(0.4 ether);
        pool.setLendingPool(address(mockLP));

        // Alice deposits and epoch flushes
        vm.prank(alice);
        pool.deposit{value: 1.0 ether}(COMMITMENT);
        vm.roll(block.number + 50);
        pool.flushEpoch();

        // LendingPool locks the nullifier (simulating a borrow)
        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH);

        // Attacker tries to withdraw the locked note with NO valid proof.
        // They pass a bogus aggregation ID (999) that has no root stored.
        // Before fix: this would SUCCEED (auto-settle path ran before proof check).
        // After fix: this REVERTS with InvalidProof.
        bytes32 root = pool.getLastRoot();

        vm.prank(attacker);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(
            root,                     // valid root
            NULLIFIER_HASH,           // locked nullifier — attacker knows from event
            payable(attacker),        // attacker as recipient
            1.0 ether,               // full note value
            DOMAIN_ID,
            999,                      // bogus aggregation ID — no proof
            new bytes32[](0),
            1,
            0
        );
    }

    /// @notice Verify that a legitimate auto-settle WITH a valid proof still works.
    function testBug1_autoSettle_withValidProof_succeeds() public {
        MockLP mockLP = new MockLP(0.4 ether);
        pool.setLendingPool(address(mockLP));

        // Alice deposits and epoch flushes
        vm.prank(alice);
        pool.deposit{value: 1.0 ether}(COMMITMENT);
        vm.roll(block.number + 50);
        pool.flushEpoch();

        // Lock the nullifier
        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH);

        // Build a valid aggregation proof
        bytes32 root = pool.getLastRoot();
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(NULLIFIER_HASH);
        inputs[2] = uint256(uint160(alice));
        inputs[3] = 1.0 ether;
        bytes32 leaf = pool.statementHash(inputs);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(DOMAIN_ID, 1, aggRoot);

        // Legitimate withdrawal: proof checks pass, then auto-settle runs
        uint256 aliceBefore = alice.balance;
        pool.withdraw(
            root, NULLIFIER_HASH, payable(alice), 1.0 ether,
            DOMAIN_ID, 1, new bytes32[](0), 1, 0
        );

        // Alice receives 1.0 - 0.4 = 0.6 ETH remainder
        assertEq(alice.balance, aliceBefore + 0.6 ether, "Alice should get remainder");
        assertTrue(mockLP.settled(), "Loan should be settled");
        assertTrue(nullifierReg.isSpent(NULLIFIER_HASH), "Nullifier should be spent");
        assertFalse(pool.lockedAsCollateral(NULLIFIER_HASH), "Lock should be released");
    }

    // =========================================================================
    // Bug 2: LeafInserted event with correct tree index
    // =========================================================================

    /// @notice After flushEpoch, LeafInserted events should give the real
    /// Merkle tree index — NOT the pendingCommitments queue index.
    /// This is what the frontend uses to build Merkle proofs.
    function testBug2_leafInserted_emitsCorrectTreeIndex() public {
        // Deposit 3 commitments
        bytes32 c1 = bytes32(uint256(1));
        bytes32 c2 = bytes32(uint256(2));
        bytes32 c3 = bytes32(uint256(3));

        vm.prank(alice);
        pool.deposit{value: 1.0 ether}(c1);
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(c2);
        vm.prank(alice);
        pool.deposit{value: 0.1 ether}(c3);

        vm.roll(block.number + 50);

        // Record logs during flushEpoch
        vm.recordLogs();
        pool.flushEpoch();

        // Parse LeafInserted events
        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 leafInsertedCount = 0;
        bytes32 leafInsertedTopic = keccak256("LeafInserted(bytes32,uint32)");

        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == leafInsertedTopic) {
                uint32 treeIndex = abi.decode(entries[i].data, (uint32));
                // Tree index should be sequential: 0, 1, 2, ... (not queue-based)
                assertEq(treeIndex, leafInsertedCount, "Tree index should be sequential");
                leafInsertedCount++;
            }
        }

        // 3 real + 10 dummies = 13 LeafInserted events
        assertEq(leafInsertedCount, 13, "Should have 13 LeafInserted events (3 real + 10 dummy)");
        // nextIndex should match
        assertEq(pool.nextIndex(), 13, "nextIndex should be 13");
    }

    // =========================================================================
    // Bug 3: _dummiesForEpoch underflow
    // =========================================================================

    /// @notice Running many epochs with adaptive dummy count should NOT revert.
    /// Before the fix: after ~47 epochs at 5 dummies/epoch (pool >200 real),
    /// `nextIndex - epochNumber * DUMMIES_PER_EPOCH` would underflow because
    /// the constant multiplier assumed 10 dummies per epoch always.
    function testBug3_dummiesForEpoch_noUnderflowAfterManyEpochs() public {
        // Insert enough real deposits to push pool past 200 (triggers 5 dummies/epoch)
        // We need >200 real deposits. Deposit 21 × 10 = 210 real deposits over 21 epochs.
        for (uint256 epoch = 0; epoch < 25; epoch++) {
            // 10 deposits per epoch
            for (uint256 d = 0; d < 10; d++) {
                vm.prank(alice);
                pool.deposit{value: 0.1 ether}(bytes32(uint256(epoch * 100 + d + 1)));
            }
            vm.roll(block.number + 50);
            pool.flushEpoch();
        }

        // At this point:
        // - realCount should be >= 200 (depends on when adaptive switches)
        // - epochNumber = 25
        // - totalDummiesInserted tracks actual dummies (not 25*10)
        // The old formula `nextIndex - epochNumber * 10` would eventually underflow.
        // With the fix, totalDummiesInserted is accurate.

        // Do 25 MORE epochs — if the old bug existed, it would underflow here
        for (uint256 epoch = 25; epoch < 50; epoch++) {
            vm.prank(alice);
            pool.deposit{value: 0.1 ether}(bytes32(uint256(epoch * 100 + 999)));
            vm.roll(block.number + 50);
            pool.flushEpoch(); // Must not revert
        }

        // If we got here without reverting, the bug is fixed
        assertTrue(pool.epochNumber() == 50, "Should have completed 50 epochs");
        assertTrue(pool.totalDummiesInserted() > 0, "Should have tracked dummies");
    }

    /// @notice Verify totalDummiesInserted is accurate after a simple epoch.
    function testBug3_totalDummiesInserted_tracksCorrectly() public {
        vm.prank(alice);
        pool.deposit{value: 1.0 ether}(COMMITMENT);

        vm.roll(block.number + 50);
        pool.flushEpoch();

        // 1 real + 10 dummies (pool < 200 real deposits)
        assertEq(pool.totalDummiesInserted(), 10, "Should have 10 dummies in first epoch");
        assertEq(pool.nextIndex(), 11, "nextIndex = 1 real + 10 dummies");
    }

    // =========================================================================
    // Additional coverage: edge cases
    // =========================================================================

    /// @notice Double-lock the same nullifier should not cause issues
    function testLockNullifier_doubleCall_noRevert() public {
        MockLP mockLP = new MockLP(0);
        pool.setLendingPool(address(mockLP));

        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH);

        // Second lock — idempotent (no revert)
        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH);

        assertTrue(pool.lockedAsCollateral(NULLIFIER_HASH));
    }

    /// @notice Auto-settle where totalOwed equals amount (zero remainder)
    function testAutoSettle_exactRepayment_zeroRemainder() public {
        MockLP mockLP = new MockLP(1.0 ether); // owed == note value
        pool.setLendingPool(address(mockLP));

        vm.prank(alice);
        pool.deposit{value: 1.0 ether}(COMMITMENT);
        vm.roll(block.number + 50);
        pool.flushEpoch();

        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH);

        bytes32 root = pool.getLastRoot();
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(NULLIFIER_HASH);
        inputs[2] = uint256(uint160(alice));
        inputs[3] = 1.0 ether;
        bytes32 leaf = pool.statementHash(inputs);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(DOMAIN_ID, 1, aggRoot);

        uint256 aliceBefore = alice.balance;
        pool.withdraw(
            root, NULLIFIER_HASH, payable(alice), 1.0 ether,
            DOMAIN_ID, 1, new bytes32[](0), 1, 0
        );

        // Alice receives nothing — entire note goes to loan repayment
        assertEq(alice.balance, aliceBefore, "Alice should get 0 ETH remainder");
        assertTrue(mockLP.settled(), "Loan should be settled");
    }

    /// @notice FlushEpoch with zero pending deposits should still insert dummies
    function testFlushEpoch_zeroPending_insertsDummiesOnly() public {
        // No deposits — just flush
        vm.roll(block.number + 50);
        pool.flushEpoch();

        // Should have 10 dummies inserted (pool is empty → realCount < 200)
        assertEq(pool.nextIndex(), 10, "10 dummies should be inserted");
        assertEq(pool.totalDummiesInserted(), 10, "Dummy tracker accurate");
    }

    /// @notice Multiple consecutive flushes with no deposits
    function testFlushEpoch_consecutiveEmpty_noPanic() public {
        for (uint256 i = 0; i < 5; i++) {
            vm.roll(block.number + 50);
            pool.flushEpoch();
        }
        // 5 epochs × 10 dummies = 50
        assertEq(pool.nextIndex(), 50);
        assertEq(pool.totalDummiesInserted(), 50);
    }

    /// @notice Withdrawal amount validation: cannot withdraw more than deposited denomination
    /// (ZK proof constrains this, but the contract should handle the ETH transfer correctly)
    function testWithdraw_amountExceedsPoolBalance_reverts() public {
        // Pool has 50 ETH from setUp. Try to withdraw 100 ETH with a "valid" proof.
        // This tests that the contract reverts on ETH transfer failure.
        vm.prank(alice);
        pool.deposit{value: 1.0 ether}(COMMITMENT);
        vm.roll(block.number + 50);
        pool.flushEpoch();

        bytes32 root = pool.getLastRoot();
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(NULLIFIER_HASH);
        inputs[2] = uint256(uint160(alice));
        inputs[3] = 100 ether; // way more than pool balance

        bytes32 leaf = pool.statementHash(inputs);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(DOMAIN_ID, 99, aggRoot);

        vm.expectRevert("Transfer failed");
        pool.withdraw(
            root, NULLIFIER_HASH, payable(alice), 100 ether,
            DOMAIN_ID, 99, new bytes32[](0), 1, 0
        );
    }
}
