// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Merkle} from "./lib/Merkle.sol";

/// @title ZkVerifyAggregation
/// @notice Stores aggregation Merkle roots posted by the zkVerify relayer and
///         lets consumer contracts verify that a specific proof-statement was
///         included in a given aggregation.
/// @dev    Mirrors the core logic of zkVerify's on-chain attestation contract
///         (ZkVerifyAggregationBase) without the OZ-upgradeable proxy layer.
///         Identical Merkle verification — not a mock.
///         See: https://github.com/zkVerify/zkv-attestation-contracts
contract ZkVerifyAggregation {
    mapping(uint256 => mapping(uint256 => bytes32)) public proofsAggregations;
    address public operator;

    event AggregationPosted(
        uint256 indexed domainId,
        uint256 indexed aggregationId,
        bytes32 indexed proofsAggregation
    );

    error Unauthorized();

    constructor(address _operator) {
        operator = _operator;
    }

    function verifyProofAggregation(
        uint256 _domainId,
        uint256 _aggregationId,
        bytes32 _leaf,
        bytes32[] calldata _merklePath,
        uint256 _leafCount,
        uint256 _index
    ) external view returns (bool) {
        bytes32 root = proofsAggregations[_domainId][_aggregationId];
        return Merkle.verifyProofKeccak(root, _merklePath, _leafCount, _index, _leaf);
    }

    function submitAggregation(
        uint256 _domainId,
        uint256 _aggregationId,
        bytes32 _proofsAggregation
    ) external {
        if (msg.sender != operator) revert Unauthorized();
        proofsAggregations[_domainId][_aggregationId] = _proofsAggregation;
        emit AggregationPosted(_domainId, _aggregationId, _proofsAggregation);
    }
}
