// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NullifierRegistry} from "./NullifierRegistry.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {IZkVerifyAggregation} from "./interfaces/IZkVerifyAggregation.sol";

/*
 * ShieldedPool — ShieldLend
 *
 * Maintains an incremental Merkle tree of deposit commitments.
 * Handles private deposits and withdrawals via ZK proof verification.
 *
 * Architecture:
 *   1. User computes commitment = Poseidon(nullifier, secret, amount) off-chain
 *   2. User calls deposit(commitment) with msg.value = amount
 *   3. Commitment is inserted into the Merkle tree
 *   4. To withdraw, user generates a ZK proof (withdraw.circom) and calls withdraw()
 *   5. ShieldedPool verifies the proof via zkVerify attestation
 *   6. NullifierRegistry marks the nullifierHash as spent
 *   7. Funds sent to recipient
 *
 * Revision note — Incremental Merkle Tree:
 *   A standard Merkle tree requires rebuilding the entire tree when a leaf is added.
 *   An incremental Merkle tree maintains O(log N) "filledSubTrees" — partial hashes
 *   at each level — allowing O(log N) insertion without touching the rest of the tree.
 *   This is the standard pattern used by Tornado Cash and all privacy protocols.
 *
 * zkVerify integration:
 *   Instead of verifying the ZK proof on-chain (costly: ~500K gas for Groth16),
 *   ShieldedPool accepts a zkVerify aggregation proof.
 *   The aggregation is an on-chain Merkle root that zkVerify has already verified.
 *   ShieldedPool recomputes the proof's statement hash from the withdrawal's public
 *   inputs and verifies Merkle inclusion against the aggregation root.
 *   This costs ~10-50K gas instead of ~500K gas (91% cheaper).
 */
contract ShieldedPool {
    // ── Constants ────────────────────────────────────────────────────────────
    uint32 public constant LEVELS = 20;    // 2^20 = ~1M possible deposits
    uint256 public constant FIELD_SIZE =   // BabyJubJub field prime (used by Poseidon in circomlib)
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // zkVerify proving system identifiers (Groth16 via circom/snarkjs on BN128)
    bytes32 public constant PROVING_SYSTEM_ID = keccak256(abi.encodePacked("groth16"));
    bytes32 public constant VERSION_HASH = sha256(abi.encodePacked(""));

    // ── State ─────────────────────────────────────────────────────────────────
    NullifierRegistry public immutable nullifierRegistry;
    IZkVerifyAggregation public immutable zkVerifyAggregation;
    bytes32 public immutable vkHash; // keccak256 of the withdraw circuit verification key

    // Incremental Merkle tree state
    bytes32[LEVELS] public filledSubTrees; // partial hashes at each tree level
    bytes32 public currentRoot;            // current Merkle root
    uint32 public nextIndex;               // index of the next empty leaf slot

    // Roots history — allows withdrawals during root transitions (e.g., if root changes between proof generation and submission)
    uint32 public constant ROOT_HISTORY_SIZE = 100;
    bytes32[ROOT_HISTORY_SIZE] public roots;
    uint32 public currentRootIndex;

    // ── Events ────────────────────────────────────────────────────────────────
    event Deposit(
        bytes32 indexed commitment,
        uint32 leafIndex,
        uint256 timestamp,
        uint256 amount
    );
    event Withdrawal(
        address indexed recipient,
        bytes32 nullifierHash,
        uint256 amount
    );

    // ── Errors ────────────────────────────────────────────────────────────────
    error TreeFull();
    error CommitmentAlreadyInserted();
    error InvalidProof();
    error NullifierAlreadySpent();
    error UnknownRoot();
    error InvalidAmount();

    // ── Initialization ────────────────────────────────────────────────────────
    // ZEROS: Poseidon hashes of empty subtrees at each level
    // zeros[i] = Poseidon hash of a subtree at level i with all-zero leaves
    // These are precomputed constants (same as used by Tornado Cash with Poseidon)
    bytes32[LEVELS] public ZEROS;

    constructor(
        address _nullifierRegistry,
        address _zkVerifyAggregation,
        bytes32 _vkHash
    ) {
        nullifierRegistry = NullifierRegistry(_nullifierRegistry);
        zkVerifyAggregation = IZkVerifyAggregation(_zkVerifyAggregation);
        vkHash = _vkHash;

        // Initialize ZEROS: zero leaf at level 0, then hash up
        // In production, these are precomputed Poseidon hashes of the empty tree
        // For now: zero bytes (will be replaced by actual Poseidon zero hashes in setup)
        bytes32 currentZero = bytes32(0);
        for (uint32 i = 0; i < LEVELS; i++) {
            ZEROS[i] = currentZero;
            filledSubTrees[i] = currentZero;
            currentZero = hashLeftRight(currentZero, currentZero);
        }

        currentRoot = currentZero;
        roots[0] = currentRoot;
    }

    // ── Core: Deposit ─────────────────────────────────────────────────────────
    /*
     * Insert a commitment into the Merkle tree.
     * commitment = Poseidon(nullifier, secret, amount) — computed off-chain
     * msg.value must equal the amount committed to in the circuit.
     */
    function deposit(bytes32 commitment) external payable {
        if (msg.value == 0) revert InvalidAmount();
        if (nextIndex >= 2 ** LEVELS) revert TreeFull();

        uint32 insertedIndex = _insert(commitment);

        emit Deposit(commitment, insertedIndex, block.timestamp, msg.value);
    }

    // ── Core: Withdraw ────────────────────────────────────────────────────────
    /*
     * Process a withdrawal backed by a zkVerify aggregation proof.
     *
     * @param root           Merkle root used in the ZK proof
     * @param nullifierHash  Poseidon(nullifier) — marks this deposit as spent
     * @param recipient      Address to receive the funds
     * @param amount         Amount to withdraw (must match deposited amount in commitment)
     * @param domainId       zkVerify domain ID
     * @param aggregationId  zkVerify aggregation batch ID
     * @param merklePath     Merkle siblings from leaf to aggregation root
     * @param leafCount      Total leaves in the aggregation tree
     * @param leafIndex      Position of this proof's leaf in the aggregation tree
     */
    function withdraw(
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        uint256 amount,
        uint256 domainId,
        uint256 aggregationId,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) external {
        // 1. Check root is known (within last ROOT_HISTORY_SIZE insertions)
        if (!isKnownRoot(root)) revert UnknownRoot();

        // 2. Check nullifier hasn't been spent
        if (nullifierRegistry.isSpent(nullifierHash)) revert NullifierAlreadySpent();

        // 3. Verify zkVerify aggregation proof
        if (
            !_verifyAttestation(
                root, nullifierHash, recipient, amount,
                domainId, aggregationId, merklePath, leafCount, leafIndex
            )
        ) {
            revert InvalidProof();
        }

        // 4. Mark nullifier as spent (prevents double-withdrawal)
        nullifierRegistry.markSpent(nullifierHash);

        // 5. Send funds to recipient
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawal(recipient, nullifierHash, amount);
    }

    // ── View: Root history ───────────────────────────────────────────────────
    function getLastRoot() public view returns (bytes32) {
        return roots[currentRootIndex];
    }

    function isKnownRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        uint32 i = currentRootIndex;
        do {
            if (root == roots[i]) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != currentRootIndex);
        return false;
    }

    // ── View: Leaf / statement hash helpers (useful for off-chain tooling) ───

    /// @notice Compute the zkVerify statement hash for a set of public inputs.
    ///         Off-chain callers can use this to build the aggregation leaf.
    function statementHash(uint256[] memory inputs) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                PROVING_SYSTEM_ID,
                vkHash,
                VERSION_HASH,
                keccak256(_encodePublicInputs(inputs))
            )
        );
    }

    // ── Internal: Incremental Merkle tree ────────────────────────────────────
    function _insert(bytes32 leaf) internal returns (uint32 index) {
        uint32 currentIndex = nextIndex;
        bytes32 currentLevelHash = leaf;
        bytes32 left;
        bytes32 right;

        for (uint32 i = 0; i < LEVELS; i++) {
            if (currentIndex % 2 == 0) {
                // Left child: save current hash, fill right with zero
                left = currentLevelHash;
                right = ZEROS[i];
                filledSubTrees[i] = currentLevelHash;
            } else {
                // Right child: use saved left sibling
                left = filledSubTrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hashLeftRight(left, right);
            currentIndex /= 2;
        }

        currentRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        roots[currentRootIndex] = currentLevelHash;
        currentRoot = currentLevelHash;
        nextIndex++;
        return nextIndex - 1;
    }

    /*
     * Poseidon hash of two children — matches the hash used in withdraw.circom.
     * PoseidonT3.hash([left, right]) computes Poseidon permutation with t=3
     * (2 inputs + 1 capacity element), identical to circomlib's Poseidon(2) template.
     *
     * This alignment is critical: if the contract uses a different hash than the circuit,
     * the Merkle roots won't match and every withdrawal proof will be invalid.
     */
    function hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return bytes32(PoseidonT3.hash([uint256(left), uint256(right)]));
    }

    // ── Internal: zkVerify attestation check ──────────────────────────────────
    /*
     * Reconstruct the statement hash from the withdrawal's public inputs and
     * verify Merkle inclusion against the zkVerify aggregation contract.
     *
     * The statement hash binds: proving system (groth16) + verification key +
     * version + all public inputs.  An attacker cannot substitute different
     * inputs because the leaf would differ from what zkVerify attested.
     */
    function _verifyAttestation(
        bytes32 root,
        bytes32 nullifierHash,
        address recipient,
        uint256 amount,
        uint256 domainId,
        uint256 aggregationId,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) internal view returns (bool) {
        // Reconstruct the public inputs array matching the withdraw circuit's signal order
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(nullifierHash);
        inputs[2] = uint256(uint160(recipient));
        inputs[3] = amount;

        bytes32 leaf = statementHash(inputs);

        return zkVerifyAggregation.verifyProofAggregation(
            domainId, aggregationId, leaf, merklePath, leafCount, leafIndex
        );
    }

    // ── Internal: Groth16 public-input encoding ──────────────────────────────

    /// @dev Encode public inputs in the byte order used by zkVerify's Groth16 pallet.
    ///      Each field element is byte-reversed (EVM big-endian → Substrate little-endian).
    function _encodePublicInputs(uint256[] memory inputs) internal pure returns (bytes memory) {
        uint256 n = inputs.length;
        bytes32[] memory encoded = new bytes32[](n);
        for (uint256 i; i < n;) {
            encoded[i] = _changeEndianness(inputs[i]);
            unchecked { ++i; }
        }
        return abi.encodePacked(encoded);
    }

    /// @dev Reverse byte order of a 256-bit word.
    ///      zkVerify's Groth16 verifier pallet serialises field elements in
    ///      little-endian, while the EVM stores uint256 in big-endian.
    function _changeEndianness(uint256 input) internal pure returns (bytes32 v) {
        v = bytes32(input);
        v = ((v & 0xff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00) >> 8)
          | ((v & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff) << 8);
        v = ((v & 0xffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000) >> 16)
          | ((v & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff) << 16);
        v = ((v & 0xffffffff00000000ffffffff00000000ffffffff00000000ffffffff00000000) >> 32)
          | ((v & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff) << 32);
        v = ((v & 0xffffffffffffffff0000000000000000ffffffffffffffff0000000000000000) >> 64)
          | ((v & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff) << 64);
        v = (v >> 128) | (v << 128);
    }
}
