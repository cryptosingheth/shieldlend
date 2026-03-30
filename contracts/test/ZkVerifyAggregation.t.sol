// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkVerifyAggregation} from "../src/ZkVerifyAggregation.sol";
import {Merkle} from "../src/lib/Merkle.sol";

/// @dev Exercises paths not always hit by ShieldedPool integration tests alone.
contract ZkVerifyAggregationTest is Test {
    address operator = address(this);
    address stranger = makeAddr("stranger");

    function test_submitAggregation_emitsEvent() public {
        ZkVerifyAggregation zk = new ZkVerifyAggregation(operator);
        bytes32 root = keccak256("aggregation_root");

        vm.expectEmit(true, true, true, true);
        emit ZkVerifyAggregation.AggregationPosted(7, 42, root);

        zk.submitAggregation(7, 42, root);
        assertEq(zk.proofsAggregations(7, 42), root);
    }

    function test_submitAggregation_nonOperator_reverts() public {
        ZkVerifyAggregation zk = new ZkVerifyAggregation(operator);
        vm.prank(stranger);
        vm.expectRevert(ZkVerifyAggregation.Unauthorized.selector);
        zk.submitAggregation(0, 1, bytes32(uint256(1)));
    }

    function test_verifyProofAggregation_withStoredRoot_singleLeaf() public {
        ZkVerifyAggregation zk = new ZkVerifyAggregation(operator);
        bytes32 leaf = bytes32(uint256(0xabc));
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zk.submitAggregation(1, 2, aggRoot);

        bytes32[] memory empty = new bytes32[](0);
        bool ok = zk.verifyProofAggregation(1, 2, leaf, empty, 1, 0);
        assertTrue(ok);
    }

    function test_verifyProofAggregation_wrongRoot_returnsFalse() public {
        ZkVerifyAggregation zk = new ZkVerifyAggregation(operator);
        zk.submitAggregation(0, 0, bytes32(uint256(0xdead)));

        bytes32[] memory empty = new bytes32[](0);
        bool ok = zk.verifyProofAggregation(0, 0, bytes32(uint256(1)), empty, 1, 0);
        assertFalse(ok);
    }

    function test_verifyProofAggregation_indexOutOfBounds_reverts() public {
        ZkVerifyAggregation zk = new ZkVerifyAggregation(operator);
        zk.submitAggregation(0, 0, bytes32(uint256(1)));

        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(Merkle.IndexOutOfBounds.selector);
        zk.verifyProofAggregation(0, 0, bytes32(0), empty, 1, 1);
    }
}
