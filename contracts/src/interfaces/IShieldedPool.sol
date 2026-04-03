// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IShieldedPool {
    function lockNullifier(bytes32 n) external;
    function disburseLoan(address payable recipient, uint256 amount) external;
}
