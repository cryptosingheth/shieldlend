// SPDX-License-Identifier: Apache-2.0
// Adapted from zkVerify's attestation contracts — Substrate binary_merkle_tree v15.0.0
// Source: https://github.com/zkVerify/zkv-attestation-contracts/blob/main/contracts/lib/Merkle.sol
pragma solidity ^0.8.24;

library Merkle {
    error IndexOutOfBounds();

    /// @dev Verify a Merkle proof for a leaf in a binary Merkle tree built by
    ///      Substrate's `binary_merkle_tree` crate (keccak256 variant).
    function verifyProofKeccak(
        bytes32 root,
        bytes32[] calldata proof,
        uint256 numberOfLeaves,
        uint256 leafIndex,
        bytes32 leaf
    ) internal pure returns (bool) {
        if (leafIndex >= numberOfLeaves) {
            revert IndexOutOfBounds();
        }

        bytes32 computedHash = keccak256(abi.encodePacked(leaf));

        uint256 position = leafIndex;
        uint256 width = numberOfLeaves;

        uint256 limit = proof.length;
        for (uint256 i; i < limit;) {
            bytes32 proofElement = proof[i];

            if (position % 2 == 1 || position + 1 == width) {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            } else {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            }

            position /= 2;
            width = (width - 1) / 2 + 1;

            unchecked {
                ++i;
            }
        }

        return computedHash == root;
    }
}
