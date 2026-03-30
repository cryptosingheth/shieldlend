// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @dev Interface for the zkVerify aggregation contract deployed on EVM chains.
/// See: https://github.com/zkVerify/zkv-attestation-contracts
interface IZkVerifyAggregation {
    function verifyProofAggregation(
        uint256 _domainId,
        uint256 _aggregationId,
        bytes32 _leaf,
        bytes32[] calldata _merklePath,
        uint256 _leafCount,
        uint256 _index
    ) external view returns (bool);
}
