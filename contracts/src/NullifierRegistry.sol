// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NullifierRegistry
/// @notice Tracks spent nullifiers to prevent double-spending of shielded notes.
///         Any registered shard (ShieldedPool instance) can mark nullifiers as spent.
///         Supports multi-shard deployments — all 5 ShieldedPool shards share one registry.
contract NullifierRegistry {
    address public admin;
    mapping(address => bool) public isRegisteredShard;
    mapping(bytes32 => bool) private _spent;

    error AlreadySpent();
    error NotRegisteredShard();
    error NotAdmin();

    event ShardRegistered(address indexed shard);

    constructor(address _admin) {
        admin = _admin == address(0) ? msg.sender : _admin;
    }

    // ── Admin functions ───────────────────────────────────────────────────────

    /// @notice Register a ShieldedPool shard that is allowed to mark nullifiers spent.
    /// @dev Can be called multiple times to add all 5 shards.
    function registerShard(address shard) external {
        if (msg.sender != admin) revert NotAdmin();
        isRegisteredShard[shard] = true;
        emit ShardRegistered(shard);
    }

    /// @notice Convenience: register the first (and only) shard.
    ///         Kept for backwards-compat with single-shard tests and deploys.
    function setShieldedPool(address shard) external {
        if (msg.sender != admin) revert NotAdmin();
        isRegisteredShard[shard] = true;
        emit ShardRegistered(shard);
    }

    // ── Core functions ────────────────────────────────────────────────────────

    /// @notice Mark a nullifier as spent. Only callable by a registered shard.
    function markSpent(bytes32 nullifierHash) external {
        if (!isRegisteredShard[msg.sender]) revert NotRegisteredShard();
        if (_spent[nullifierHash]) revert AlreadySpent();
        _spent[nullifierHash] = true;
    }

    /// @notice Returns true if the nullifier has been spent.
    function isSpent(bytes32 nullifierHash) external view returns (bool) {
        return _spent[nullifierHash];
    }

    // ── Legacy single-address view (backwards-compat) ─────────────────────────

    /// @notice Returns address(0) — registry now supports multiple shards.
    ///         Kept so existing frontends that read shieldedPool don't revert.
    function shieldedPool() external pure returns (address) {
        return address(0);
    }
}
