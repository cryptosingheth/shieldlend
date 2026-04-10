// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IZkVerifyAggregation {
    function verifyProofAggregation(
        uint256 domainId,
        uint256 aggregationId,
        bytes32 leaf,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) external view returns (bool);
}
