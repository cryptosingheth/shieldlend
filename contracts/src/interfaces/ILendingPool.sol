// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILendingPool {
    function getOwed(bytes32 nullifierHash) external view returns (uint256);
    function settleCollateral(bytes32 nullifierHash) external payable;
    function disburseLoan(address payable recipient, uint256 amount) external;
}
