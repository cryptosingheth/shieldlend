// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ZkVerifyAggregation} from "../src/ZkVerifyAggregation.sol";

/*
 * ShieldedPool V2 Tests
 *
 * V2 changes covered:
 *   - Fixed denomination validation (0.001 / 0.005 / 0.01 / 0.05 / 0.1 / 0.5 ETH)
 *   - Epoch batching: commitments queue in pendingCommitments[], inserted via flushEpoch()
 *   - flushEpoch() reverts before EPOCH_BLOCKS; shuffles + inserts dummies after
 *   - Protocol fee: 0.1% per deposit -> protocolFunds
 *   - flushEpoch() tips 0.001 ETH to caller from protocolFunds
 *   - Nullifier locking: only lendingPool can call lockNullifier()
 *   - Auto-settle: withdraw with locked nullifier routes through ILendingPool
 *   - disburseLoan(): only lendingPool can call
 *   - Normal withdraw still works (zkVerify attestation path)
 */

/// @dev Mock LendingPool for auto-settle tests.
contract MockLendingPool {
    uint256 public owedAmount;
    bool public settled;

    constructor(uint256 _owed) {
        owedAmount = _owed;
    }

    receive() external payable {}

    function getOwed(bytes32 /*nullifierHash*/) external view returns (uint256) {
        return owedAmount;
    }

    function settleCollateral(bytes32 /*nullifierHash*/) external payable {
        settled = true;
    }
}

contract ShieldedPoolTest is Test {
    // Required so the test contract can receive the 0.001 ETH flushEpoch tip
    receive() external payable {}

    ShieldedPool pool;
    NullifierRegistry nullifierReg;
    ZkVerifyAggregation zkVerify;
    MockLendingPool mockLP;

    address deployer;
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    bytes32 constant COMMITMENT_1 = bytes32(uint256(0x1));
    bytes32 constant COMMITMENT_2 = bytes32(uint256(0x2));
    bytes32 constant NULLIFIER_HASH_1 = bytes32(uint256(0xABCD));
    bytes32 constant NULLIFIER_HASH_2 = bytes32(uint256(0xBEEF));
    bytes32 constant VK_HASH = keccak256("withdraw_ring_circuit_vkey_v2");

    uint256 constant DOMAIN_ID = 0;

    function setUp() public {
        deployer = address(this);

        zkVerify = new ZkVerifyAggregation(deployer);
        nullifierReg = new NullifierRegistry(address(0));
        pool = new ShieldedPool(address(nullifierReg), address(zkVerify), VK_HASH);
        nullifierReg.setShieldedPool(address(pool));

        vm.deal(alice, 100 ether);
        vm.deal(bob,   100 ether);
        vm.deal(address(pool), 10 ether); // seed pool for disbursement tests
    }

    // -- Denomination validation ----------------------------------------------

    function testDepositInvalidDenomination() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.InvalidDenomination.selector);
        pool.deposit{value: 0.2 ether}(COMMITMENT_1);
    }

    function testDepositInvalidDenomination_zero() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.InvalidDenomination.selector);
        pool.deposit{value: 0}(COMMITMENT_1);
    }

    function testDepositInvalidDenomination_arbitrary() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.InvalidDenomination.selector);
        pool.deposit{value: 0.7 ether}(COMMITMENT_1);
    }

    function testDepositValidDenomination_point1() public {
        vm.prank(alice);
        pool.deposit{value: 0.1 ether}(COMMITMENT_1);
        assertEq(pool.pendingCommitments(0), COMMITMENT_1);
    }

    function testDepositValidDenomination_point5() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_2);
        assertEq(pool.pendingCommitments(0), COMMITMENT_2);
    }

    function testDepositValidDenomination_01eth() public {
        vm.prank(alice);
        pool.deposit{value: 0.01 ether}(COMMITMENT_1);
        assertEq(pool.pendingCommitments(0), COMMITMENT_1);
    }

    // -- Epoch batching -------------------------------------------------------

    function testDepositQueuesCommitment() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);

        // Commitment must be in pending queue
        assertEq(pool.pendingCommitments(0), COMMITMENT_1);
        // Tree must NOT have been updated yet (nextIndex still 0)
        assertEq(pool.nextIndex(), 0);
    }

    function testFlushEpochTooEarly() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);

        vm.roll(block.number + 49);

        vm.expectRevert(ShieldedPool.EpochTooEarly.selector);
        pool.flushEpoch();
    }

    function testFlushEpochInsertsReal() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);

        vm.prank(bob);
        pool.deposit{value: 0.5 ether}(COMMITMENT_2);

        vm.roll(block.number + 50);
        pool.flushEpoch();

        // 2 real + 10 dummies (sparse pool) = 12 leaves
        assertGe(pool.nextIndex(), 2, "At least 2 real commitments inserted");
    }

    function testFlushEpochInsertsDummies() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);

        vm.roll(block.number + 50);

        uint256 epochBefore = pool.epochNumber();
        pool.flushEpoch();

        // 1 real + 10 dummies = 11
        assertEq(pool.nextIndex(), 11, "Should have 1 real + 10 dummy leaves");
        assertEq(pool.epochNumber(), epochBefore + 1, "Epoch should increment");
    }

    function testFlushEpochUpdatesRoot() public {
        bytes32 rootBefore = pool.getLastRoot();

        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);

        vm.roll(block.number + 50);
        pool.flushEpoch();

        assertTrue(pool.getLastRoot() != rootBefore, "Root must change after flush");
    }

    function testFlushEpochEmitsEvent() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);

        vm.roll(block.number + 50);

        vm.expectEmit(true, false, false, false);
        emit ShieldedPool.EpochFlushed(0, 1, 10);
        pool.flushEpoch();
    }

    function testFlushEpochClearsPending() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);
        vm.prank(bob);
        pool.deposit{value: 0.5 ether}(COMMITMENT_2);

        vm.roll(block.number + 50);
        pool.flushEpoch();

        vm.expectRevert();
        pool.pendingCommitments(0);
    }

    function testFlushEpochTipsToCaller() public {
        // Two 0.5 ETH deposits: combined fee 0.1% × 1 ETH = 0.001 ETH → one full tip
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);
        vm.prank(bob);
        pool.deposit{value: 0.5 ether}(COMMITMENT_2);

        vm.roll(block.number + 50);

        address caller = makeAddr("caller");
        uint256 before = caller.balance;
        vm.prank(caller);
        pool.flushEpoch();

        assertEq(caller.balance, before + 0.001 ether);
    }

    function testProtocolFeeAccumulates() public {
        uint256 fundsBefore = pool.protocolFunds();
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);
        // 0.1% of 0.5 ETH = 0.0005 ETH
        assertEq(pool.protocolFunds(), fundsBefore + 0.0005 ether);
    }

    // -- Nullifier locking ----------------------------------------------------

    function testLockNullifier_onlyLendingPool() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.NotLendingPool.selector);
        pool.lockNullifier(NULLIFIER_HASH_1);
    }

    function testLockNullifier_byLendingPool() public {
        mockLP = new MockLendingPool(0);
        pool.setLendingPool(address(mockLP));

        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH_1);

        assertTrue(pool.lockedAsCollateral(NULLIFIER_HASH_1));
    }

    function testLockNullifier_emitsEvent() public {
        mockLP = new MockLendingPool(0);
        pool.setLendingPool(address(mockLP));

        vm.prank(address(mockLP));
        vm.expectEmit(true, false, false, false);
        emit ShieldedPool.NullifierLocked(NULLIFIER_HASH_1);
        pool.lockNullifier(NULLIFIER_HASH_1);
    }

    // -- disburseLoan ---------------------------------------------------------

    function testDisburseLoan_onlyLendingPool() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.NotLendingPool.selector);
        pool.disburseLoan(payable(bob), 1 ether);
    }

    function testDisburseLoan_byLendingPool() public {
        mockLP = new MockLendingPool(0);
        pool.setLendingPool(address(mockLP));

        uint256 bobBefore = bob.balance;
        vm.prank(address(mockLP));
        pool.disburseLoan(payable(bob), 1 ether);

        assertEq(bob.balance, bobBefore + 1 ether);
    }

    function testDisburseLoan_emitsEvent() public {
        mockLP = new MockLendingPool(0);
        pool.setLendingPool(address(mockLP));

        vm.prank(address(mockLP));
        vm.expectEmit(true, false, false, true);
        emit ShieldedPool.LoanDisbursed(bob, 1 ether);
        pool.disburseLoan(payable(bob), 1 ether);
    }

    // -- Auto-settle on withdraw ----------------------------------------------

    function _depositAndFlush(bytes32 commitment, uint256 denomination) internal {
        vm.prank(alice);
        pool.deposit{value: denomination}(commitment);
        vm.roll(block.number + 50);
        pool.flushEpoch();
    }

    function testAutoSettle_settlesLoanAndSendsRemainder() public {
        uint256 owed = 0.4 ether;
        mockLP = new MockLendingPool(owed);
        pool.setLendingPool(address(mockLP));

        _depositAndFlush(COMMITMENT_1, 0.5 ether);

        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH_1);
        assertTrue(pool.lockedAsCollateral(NULLIFIER_HASH_1));

        bytes32 root = pool.getLastRoot();
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, 0.5 ether);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(DOMAIN_ID, 1, aggRoot);

        uint256 bobBefore = bob.balance;
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), 0.5 ether,
            DOMAIN_ID, 1, new bytes32[](0), 1, 0
        );

        // Bob receives 0.5 - 0.4 = 0.1 ETH remainder
        assertEq(bob.balance, bobBefore + 0.1 ether, "Bob should receive remainder");
        assertTrue(mockLP.settled(), "Loan should be settled");
        assertTrue(nullifierReg.isSpent(NULLIFIER_HASH_1), "Nullifier should be spent");
    }

    function testAutoSettle_insufficientCollateral_reverts() public {
        uint256 owed = 0.6 ether; // more than the 0.5 ETH note
        mockLP = new MockLendingPool(owed);
        pool.setLendingPool(address(mockLP));

        _depositAndFlush(COMMITMENT_1, 0.5 ether);

        vm.prank(address(mockLP));
        pool.lockNullifier(NULLIFIER_HASH_1);

        bytes32 root = pool.getLastRoot();
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, 0.5 ether);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(DOMAIN_ID, 2, aggRoot);

        vm.expectRevert(ShieldedPool.InsufficientCollateralForSettlement.selector);
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), 0.5 ether,
            DOMAIN_ID, 2, new bytes32[](0), 1, 0
        );
    }

    // -- Normal withdraw ------------------------------------------------------

    function testNormalWithdraw() public {
        _depositAndFlush(COMMITMENT_1, 0.5 ether);

        bytes32 root = pool.getLastRoot();
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, 0.5 ether);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(DOMAIN_ID, 10, aggRoot);

        uint256 bobBefore = bob.balance;
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), 0.5 ether,
            DOMAIN_ID, 10, new bytes32[](0), 1, 0
        );

        assertEq(bob.balance, bobBefore + 0.5 ether);
        assertTrue(nullifierReg.isSpent(NULLIFIER_HASH_1));
    }

    function testNormalWithdraw_unknownRootReverts() public {
        _depositAndFlush(COMMITMENT_1, 0.5 ether);

        bytes32 fakeRoot = bytes32(uint256(0xdead));
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.withdraw(
            fakeRoot, NULLIFIER_HASH_1, payable(bob), 0.5 ether,
            DOMAIN_ID, 1, new bytes32[](0), 1, 0
        );
    }

    function testNormalWithdraw_spentNullifierReverts() public {
        _depositAndFlush(COMMITMENT_1, 0.5 ether);

        bytes32 root = pool.getLastRoot();
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, 0.5 ether);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(DOMAIN_ID, 10, aggRoot);

        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), 0.5 ether,
            DOMAIN_ID, 10, new bytes32[](0), 1, 0
        );

        vm.expectRevert(ShieldedPool.NullifierAlreadySpent.selector);
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), 0.5 ether,
            DOMAIN_ID, 10, new bytes32[](0), 1, 0
        );
    }

    function testNormalWithdraw_invalidProofReverts() public {
        _depositAndFlush(COMMITMENT_1, 0.5 ether);

        bytes32 root = pool.getLastRoot();
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), 0.5 ether,
            DOMAIN_ID, 999, new bytes32[](0), 1, 0
        );
    }

    // -- Root history ---------------------------------------------------------

    function testRootHistory_isKnownAfterFlush() public {
        _depositAndFlush(COMMITMENT_1, 0.5 ether);
        bytes32 root = pool.getLastRoot();
        assertTrue(pool.isKnownRoot(root));
    }

    function testRootHistory_unknownRootFails() public {
        assertFalse(pool.isKnownRoot(bytes32(uint256(0xBAD))));
        assertFalse(pool.isKnownRoot(bytes32(0)));
    }

    // -- Admin ----------------------------------------------------------------

    function testSetLendingPool_onlyAdmin() public {
        vm.prank(alice);
        vm.expectRevert(ShieldedPool.NotAdmin.selector);
        pool.setLendingPool(alice);
    }

    function testSetLendingPool_byAdmin() public {
        pool.setLendingPool(alice);
        assertEq(pool.lendingPool(), alice);
    }

    // -- Statement hash determinism -------------------------------------------

    function testStatementHash_isDeterministic() public view {
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = 111; inputs[1] = 222; inputs[2] = 333; inputs[3] = 444;
        bytes32 h1 = pool.statementHash(inputs);
        bytes32 h2 = pool.statementHash(inputs);
        assertEq(h1, h2);
        assertTrue(h1 != bytes32(0));
    }

    function testStatementHash_changesWithInputs() public view {
        uint256[] memory a = new uint256[](4);
        a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4;
        uint256[] memory b = new uint256[](4);
        b[0] = 1; b[1] = 2; b[2] = 3; b[3] = 5;
        assertTrue(pool.statementHash(a) != pool.statementHash(b));
    }

    // -- Helpers --------------------------------------------------------------

    function _buildLeaf(
        bytes32 root,
        bytes32 nullifierHash,
        address recipient,
        uint256 amount
    ) internal view returns (bytes32) {
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(nullifierHash);
        inputs[2] = uint256(uint160(recipient));
        inputs[3] = amount;
        return pool.statementHash(inputs);
    }
}
