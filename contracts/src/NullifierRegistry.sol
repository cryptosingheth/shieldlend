// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * NullifierRegistry — ShieldLend
 *
 * Tracks spent nullifier hashes to prevent double-withdrawals.
 * A nullifier is the Poseidon hash of the depositor's private `nullifier` field.
 * Once a nullifier hash is marked spent, the same deposit note cannot be withdrawn twice.
 *
 * Revision note — Why nullifiers work:
 *   The nullifier is a private value known only to the depositor.
 *   nullifierHash = Poseidon(nullifier) is computed in the withdraw circuit.
 *   The withdraw proof guarantees: "the nullifier in my commitment equals this nullifierHash"
 *   So: if two withdrawals share the same nullifierHash, they came from the same deposit.
 *   The contract rejects the second one.
 *   Crucially: the nullifierHash does NOT reveal WHICH commitment was withdrawn
 *   (because Poseidon is one-way — you can't reverse it to find the leaf).
 */
contract NullifierRegistry {
    // nullifierHash → spent
    mapping(bytes32 => bool) private _spent;

    // Only ShieldedPool can mark nullifiers as spent
    address public shieldedPool;
    address public immutable admin;

    event NullifierSpent(bytes32 indexed nullifierHash);

    error AlreadySpent(bytes32 nullifierHash);
    error Unauthorized();
    error AlreadyInitialized();

    constructor(address _shieldedPool) {
        shieldedPool = _shieldedPool;
        admin = msg.sender;
    }

    /*
     * One-time setter for ShieldedPool address.
     * Needed because ShieldedPool and NullifierRegistry have a circular dependency:
     * each needs the other's address at deploy time. This initializer breaks the cycle.
     * Can only be called once by the deployer.
     */
    function setShieldedPool(address _shieldedPool) external {
        if (msg.sender != admin) revert Unauthorized();
        if (shieldedPool != address(0)) revert AlreadyInitialized();
        shieldedPool = _shieldedPool;
    }

    modifier onlyPool() {
        if (msg.sender != shieldedPool) revert Unauthorized();
        _;
    }

    /*
     * Mark a nullifier as spent.
     * Called by ShieldedPool after a successful withdrawal proof verification.
     * Reverts if already spent (prevents double-withdrawal).
     */
    function markSpent(bytes32 nullifierHash) external onlyPool {
        if (_spent[nullifierHash]) revert AlreadySpent(nullifierHash);
        _spent[nullifierHash] = true;
        emit NullifierSpent(nullifierHash);
    }

    /*
     * Check if a nullifier has been spent.
     * Called by ShieldedPool before processing a withdrawal.
     */
    function isSpent(bytes32 nullifierHash) external view returns (bool) {
        return _spent[nullifierHash];
    }
}
