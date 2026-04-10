// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ZkVerifyAggregation — on-chain aggregation root storage
 * ========================================================
 * Stores statement-hash aggregation roots submitted by the operator.
 * verifyProofAggregation() checks a leaf is included in the stored root
 * by recomputing the Merkle path from the submitted leaf and siblings.
 *
 * In production, the operator calls submitAggregation() after the zkVerify
 * pallet confirms a Groth16 proof batch on the Horizen network.
 */
contract ZkVerifyAggregation {
    address public immutable operator;

    // domainId => aggregationId => root
    mapping(uint256 => mapping(uint256 => bytes32)) public aggregationRoots;

    error NotOperator();
    error RootAlreadySubmitted();

    constructor(address _operator) {
        operator = _operator;
    }

    /**
     * @notice Submit an aggregation root for a completed proof batch.
     * @param domainId   The zkVerify circuit domain (vkHash-derived).
     * @param aggregationId Monotonically-increasing batch identifier.
     * @param root       Merkle root of statement hashes in this batch.
     */
    function submitAggregation(uint256 domainId, uint256 aggregationId, bytes32 root) external {
        if (msg.sender != operator) revert NotOperator();
        if (aggregationRoots[domainId][aggregationId] != bytes32(0)) revert RootAlreadySubmitted();
        aggregationRoots[domainId][aggregationId] = root;
    }

    /**
     * @notice Verify a statement hash (leaf) is included in a stored aggregation root.
     * @param domainId      Circuit domain.
     * @param aggregationId Batch identifier.
     * @param leaf          Statement hash to verify.
     * @param merklePath    Sibling hashes from leaf to root.
     * @param leafCount     Total leaf count in the Merkle tree (for parity computation).
     * @param leafIndex     Zero-based index of this leaf.
     * @return true if the leaf is included in the stored root.
     */
    function verifyProofAggregation(
        uint256 domainId,
        uint256 aggregationId,
        bytes32 leaf,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) external view returns (bool) {
        bytes32 root = aggregationRoots[domainId][aggregationId];
        if (root == bytes32(0)) return false;

        // Single-leaf batch: root = keccak256(leaf), empty path.
        // zkVerify convention: even a 1-element tree hashes the leaf once.
        if (merklePath.length == 0 && leafCount == 1) {
            return root == keccak256(abi.encodePacked(leaf));
        }

        // Multi-leaf: recompute root from leaf + sibling hashes
        bytes32 current = leaf;
        uint256 idx = leafIndex;
        for (uint256 i = 0; i < merklePath.length; i++) {
            bytes32 sibling = merklePath[i];
            if (idx % 2 == 0) {
                current = keccak256(abi.encodePacked(current, sibling));
            } else {
                current = keccak256(abi.encodePacked(sibling, current));
            }
            idx /= 2;
        }

        return current == root;
    }
}
