// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NullifierRegistry} from "./NullifierRegistry.sol";

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
 *   ShieldedPool accepts a zkVerify attestationId.
 *   The attestation is an on-chain proof that zkVerify has already verified the proof.
 *   This costs ~10-50K gas instead of ~500K gas (91% cheaper).
 */
contract ShieldedPool {
    // ── Constants ────────────────────────────────────────────────────────────
    uint32 public constant LEVELS = 20;    // 2^20 = ~1M possible deposits
    uint256 public constant FIELD_SIZE =   // BabyJubJub field prime (used by Poseidon in circomlib)
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ── State ─────────────────────────────────────────────────────────────────
    NullifierRegistry public immutable nullifierRegistry;
    address public immutable zkVerifyAttestation; // zkVerify on-chain attestation contract

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

    constructor(address _nullifierRegistry, address _zkVerifyAttestation) {
        nullifierRegistry = NullifierRegistry(_nullifierRegistry);
        zkVerifyAttestation = _zkVerifyAttestation;

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
     * Process a withdrawal backed by a zkVerify attestation.
     *
     * @param proof          Groth16 proof bytes (for on-chain record / fallback)
     * @param root           Merkle root used in the proof
     * @param nullifierHash  Poseidon(nullifier) — marks this deposit as spent
     * @param recipient      Address to receive the funds
     * @param amount         Amount to withdraw (must match deposited amount in commitment)
     * @param attestationId  zkVerify proof verification attestation ID
     */
    function withdraw(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        uint256 amount,
        uint256 attestationId
    ) external {
        // 1. Check root is known (within last ROOT_HISTORY_SIZE insertions)
        if (!isKnownRoot(root)) revert UnknownRoot();

        // 2. Check nullifier hasn't been spent
        if (nullifierRegistry.isSpent(nullifierHash)) revert NullifierAlreadySpent();

        // 3. Verify zkVerify attestation (proof was verified by zkVerify chain)
        if (!_verifyAttestation(attestationId, proof, root, nullifierHash, recipient, amount)) {
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
     * Poseidon hash of two children.
     * In production: replace with a proper Poseidon precompile call or library.
     * For now: uses keccak256 as placeholder — MUST be replaced before deployment.
     *
     * TODO: integrate the Poseidon library (e.g., from circomlibjs or a Solidity port)
     */
    function hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        // PLACEHOLDER — replace with Poseidon(left, right) before deployment
        // Using keccak256 here breaks the circuit-contract alignment.
        // The withdraw.circom uses Poseidon; the contract must use the same hash.
        return keccak256(abi.encodePacked(left, right));
    }

    // ── Internal: zkVerify attestation check ──────────────────────────────────
    /*
     * Verify that a zkVerify attestation covers this withdrawal's public inputs.
     * In production: call the zkVerify attestation contract to verify the attestationId
     * corresponds to a proof with the given public inputs.
     *
     * TODO: implement full zkVerify SDK integration (see scripts/zkverify.js)
     */
    function _verifyAttestation(
        uint256 attestationId,
        bytes calldata, /* proof */
        bytes32 root,
        bytes32 nullifierHash,
        address recipient,
        uint256 amount
    ) internal view returns (bool) {
        // In production: call IZkVerifyAttestation(zkVerifyAttestation).verify(...)
        // For now: placeholder that always returns true (for local testing)
        // MUST be replaced before production deployment
        return true; // TODO: zkVerify integration
    }
}
