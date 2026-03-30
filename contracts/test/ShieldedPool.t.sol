// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ZkVerifyAggregation} from "../src/ZkVerifyAggregation.sol";

/*
 * ShieldedPool Tests
 *
 * Exercises the full zkVerify attestation verification path:
 *   - Deploys the real ZkVerifyAggregation contract (same Merkle logic as mainnet)
 *   - Builds real aggregation Merkle trees from statement hashes
 *   - Submits aggregation roots and verifies Merkle inclusion on-chain
 *
 * No mocking — every verification path executes the production code.
 */
contract ShieldedPoolTest is Test {
    ShieldedPool pool;
    NullifierRegistry nullifierReg;
    ZkVerifyAggregation zkVerify;

    address deployer;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant COMMITMENT_1 = bytes32(uint256(0x1));
    bytes32 constant COMMITMENT_2 = bytes32(uint256(0x2));
    bytes32 constant NULLIFIER_HASH_1 = bytes32(uint256(0xABCD));
    bytes32 constant NULLIFIER_HASH_2 = bytes32(uint256(0xBEEF));
    bytes32 constant VK_HASH = keccak256("withdraw_circuit_vkey_v1");

    uint256 constant DOMAIN_ID = 0;

    function setUp() public {
        deployer = address(this);

        zkVerify = new ZkVerifyAggregation(deployer);

        nullifierReg = new NullifierRegistry(address(0));
        pool = new ShieldedPool(address(nullifierReg), address(zkVerify), VK_HASH);
        nullifierReg.setShieldedPool(address(pool));

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

        assertTrue(root1 != root2, "Root should change with each deposit");
        assertEq(pool.nextIndex(), 2);
    }

    function test_rootHistory_isKnown() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();
        assertTrue(pool.isKnownRoot(root), "Root should be in history");
    }

    // ── Withdraw tests — single-leaf aggregation ─────────────────────────────

    function test_withdraw_singleLeafAggregation() public {
        uint256 amount = 1 ether;
        vm.prank(alice);
        pool.deposit{value: amount}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();
        uint256 bobBefore = bob.balance;

        // Build the statement leaf the same way ShieldedPool does
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, amount);

        // Single-leaf aggregation: root = keccak256(leaf)
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        uint256 aggregationId = 1;

        zkVerify.submitAggregation(DOMAIN_ID, aggregationId, aggRoot);

        bytes32[] memory emptyPath = new bytes32[](0);

        vm.expectEmit(true, true, false, true);
        emit ShieldedPool.Withdrawal(bob, NULLIFIER_HASH_1, amount);

        pool.withdraw(
            root,
            NULLIFIER_HASH_1,
            payable(bob),
            amount,
            DOMAIN_ID,
            aggregationId,
            emptyPath,
            1, // leafCount
            0  // leafIndex
        );

        assertEq(bob.balance, bobBefore + amount);
        assertTrue(nullifierReg.isSpent(NULLIFIER_HASH_1));
    }

    // ── Withdraw tests — multi-leaf aggregation (2 proofs) ───────────────────

    function test_withdraw_multiLeafAggregation_twoLeaves() public {
        vm.prank(alice);
        pool.deposit{value: 2 ether}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();

        bytes32 leaf0 = _buildLeaf(root, NULLIFIER_HASH_1, bob, 1 ether);
        bytes32 leaf1 = _buildLeaf(root, NULLIFIER_HASH_2, alice, 1 ether);

        // Build 2-leaf aggregation Merkle tree and submit
        (bytes32 h0, bytes32 h1) = _hashLeaves(leaf0, leaf1);
        bytes32 aggRoot = keccak256(abi.encodePacked(h0, h1));
        zkVerify.submitAggregation(DOMAIN_ID, 42, aggRoot);

        // Withdraw leaf0 (index=0), sibling = h1
        _withdrawAndAssert(root, NULLIFIER_HASH_1, bob, 1 ether, 42, _singleProof(h1), 2, 0);

        // Withdraw leaf1 (index=1), sibling = h0
        _withdrawAndAssert(root, NULLIFIER_HASH_2, alice, 1 ether, 42, _singleProof(h0), 2, 1);
    }

    // ── Withdraw tests — 3-leaf aggregation tree ─────────────────────────────

    function test_withdraw_threeLeafAggregation() public {
        vm.prank(alice);
        pool.deposit{value: 0.5 ether}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();

        // Build 3-leaf tree and submit; returns proof for leaf at index 0
        bytes32[] memory proof0 = _setup3LeafAggregation(root);

        _withdrawAndAssert(root, NULLIFIER_HASH_1, bob, 0.5 ether, 99, proof0, 3, 0);
    }

    // ── Revert tests ─────────────────────────────────────────────────────────

    function test_withdraw_reverts_unknownRoot() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT_1);

        bytes32 fakeRoot = bytes32(uint256(0xdead));
        bytes32[] memory emptyPath = new bytes32[](0);

        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.withdraw(
            fakeRoot, NULLIFIER_HASH_1, payable(bob), 1 ether,
            DOMAIN_ID, 1, emptyPath, 1, 0
        );
    }

    function test_withdraw_reverts_zeroRoot() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT_1);

        bytes32[] memory emptyPath = new bytes32[](0);

        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.withdraw(
            bytes32(0), NULLIFIER_HASH_1, payable(bob), 1 ether,
            DOMAIN_ID, 1, emptyPath, 1, 0
        );
    }

    function test_withdraw_reverts_nullifierAlreadySpent() public {
        uint256 amount = 1 ether;
        vm.prank(alice);
        pool.deposit{value: amount}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, amount);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        uint256 aggregationId = 1;
        zkVerify.submitAggregation(DOMAIN_ID, aggregationId, aggRoot);

        bytes32[] memory emptyPath = new bytes32[](0);

        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), amount,
            DOMAIN_ID, aggregationId, emptyPath, 1, 0
        );

        vm.expectRevert(ShieldedPool.NullifierAlreadySpent.selector);
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), amount,
            DOMAIN_ID, aggregationId, emptyPath, 1, 0
        );
    }

    function test_withdraw_reverts_invalidProof_wrongAmount() public {
        uint256 amount = 1 ether;
        vm.prank(alice);
        pool.deposit{value: amount}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();

        // Aggregation was built for amount=1 ether
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, amount);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        uint256 aggregationId = 1;
        zkVerify.submitAggregation(DOMAIN_ID, aggregationId, aggRoot);

        bytes32[] memory emptyPath = new bytes32[](0);

        // Try to withdraw 2 ether — leaf won't match
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), 2 ether,
            DOMAIN_ID, aggregationId, emptyPath, 1, 0
        );
    }

    function test_withdraw_reverts_invalidProof_wrongRecipient() public {
        uint256 amount = 1 ether;
        vm.prank(alice);
        pool.deposit{value: amount}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();
        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, bob, amount);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        uint256 aggregationId = 1;
        zkVerify.submitAggregation(DOMAIN_ID, aggregationId, aggRoot);

        bytes32[] memory emptyPath = new bytes32[](0);

        // Try to redirect to alice — leaf was built for bob
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(alice), amount,
            DOMAIN_ID, aggregationId, emptyPath, 1, 0
        );
    }

    function test_withdraw_reverts_noAggregation() public {
        uint256 amount = 1 ether;
        vm.prank(alice);
        pool.deposit{value: amount}(COMMITMENT_1);

        bytes32 root = pool.getLastRoot();
        bytes32[] memory emptyPath = new bytes32[](0);

        // No aggregation was submitted — root is bytes32(0), Merkle check fails
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(bob), amount,
            DOMAIN_ID, 999, emptyPath, 1, 0
        );
    }

    function test_withdraw_reverts_whenTransferFails() public {
        uint256 amount = 1 ether;
        vm.prank(alice);
        pool.deposit{value: amount}(COMMITMENT_1);

        RejectETH rejecter = new RejectETH();
        bytes32 root = pool.getLastRoot();

        bytes32 leaf = _buildLeaf(root, NULLIFIER_HASH_1, address(rejecter), amount);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        uint256 aggregationId = 1;
        zkVerify.submitAggregation(DOMAIN_ID, aggregationId, aggRoot);

        bytes32[] memory emptyPath = new bytes32[](0);

        vm.expectRevert(bytes("Transfer failed"));
        pool.withdraw(
            root, NULLIFIER_HASH_1, payable(address(rejecter)), amount,
            DOMAIN_ID, aggregationId, emptyPath, 1, 0
        );

        assertFalse(nullifierReg.isSpent(NULLIFIER_HASH_1), "reverted withdraw must not consume nullifier");
    }

    // ── Nullifier registry tests ─────────────────────────────────────────────

    function test_nullifier_notSpentInitially() public view {
        assertFalse(nullifierReg.isSpent(NULLIFIER_HASH_1));
    }

    function test_nullifier_unauthorizedMark_reverts() public {
        vm.prank(alice);
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

    // ── Statement hash determinism ───────────────────────────────────────────

    function test_statementHash_isDeterministic() public view {
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = 111;
        inputs[1] = 222;
        inputs[2] = 333;
        inputs[3] = 444;

        bytes32 h1 = pool.statementHash(inputs);
        bytes32 h2 = pool.statementHash(inputs);

        assertEq(h1, h2, "Statement hash must be deterministic");
        assertTrue(h1 != bytes32(0), "Statement hash must be non-zero");
    }

    function test_statementHash_changesWithInputs() public view {
        uint256[] memory a = new uint256[](4);
        a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4;

        uint256[] memory b = new uint256[](4);
        b[0] = 1; b[1] = 2; b[2] = 3; b[3] = 5; // last input differs

        assertTrue(
            pool.statementHash(a) != pool.statementHash(b),
            "Different inputs must produce different hashes"
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Build the statement leaf exactly as ShieldedPool._verifyAttestation does.
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

    /// @dev Build a 3-leaf aggregation tree with the real withdrawal leaf at index 0
    ///      and two dummy leaves. Submits to zkVerify with aggregationId=99.
    ///      Returns the Merkle proof for index 0.
    function _setup3LeafAggregation(bytes32 root) internal returns (bytes32[] memory) {
        bytes32 leaf0 = _buildLeaf(root, NULLIFIER_HASH_1, bob, 0.5 ether);
        bytes32 h0 = keccak256(abi.encodePacked(leaf0));
        bytes32 h1 = keccak256(abi.encodePacked(keccak256("dummy_proof_1")));
        bytes32 h2 = keccak256(abi.encodePacked(keccak256("dummy_proof_2")));

        bytes32 n01 = keccak256(abi.encodePacked(h0, h1));
        bytes32 aggRoot = keccak256(abi.encodePacked(n01, h2));
        zkVerify.submitAggregation(DOMAIN_ID, 99, aggRoot);

        bytes32[] memory proof = new bytes32[](2);
        proof[0] = h1;
        proof[1] = h2;
        return proof;
    }

    function _hashLeaves(bytes32 a, bytes32 b) internal pure returns (bytes32, bytes32) {
        return (keccak256(abi.encodePacked(a)), keccak256(abi.encodePacked(b)));
    }

    function _singleProof(bytes32 sibling) internal pure returns (bytes32[] memory) {
        bytes32[] memory p = new bytes32[](1);
        p[0] = sibling;
        return p;
    }

    function _withdrawAndAssert(
        bytes32 root,
        bytes32 nullifierHash,
        address recipient,
        uint256 amount,
        uint256 aggregationId,
        bytes32[] memory mPath,
        uint256 leafCount,
        uint256 leafIndex
    ) internal {
        uint256 balBefore = recipient.balance;
        pool.withdraw(
            root, nullifierHash, payable(recipient), amount,
            DOMAIN_ID, aggregationId, mPath, leafCount, leafIndex
        );
        assertEq(recipient.balance, balBefore + amount);
        assertTrue(nullifierReg.isSpent(nullifierHash));
    }
}

/// @dev Reverts on any ETH receipt so ShieldedPool's withdraw transfer fails.
contract RejectETH {
    receive() external payable {
        revert();
    }
}
