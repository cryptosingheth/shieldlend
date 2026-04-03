// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ZkVerifyAggregation} from "../src/ZkVerifyAggregation.sol";

/*
 * Gas Benchmarks — ShieldLend V2
 *
 * Measures gas cost of the key on-chain operations.
 * Run with:  forge test --match-path contracts/test/Gas.t.sol -v
 *
 * V2 changes from V1:
 *   - deposit() now queues to pendingCommitments (faster — no tree insertion)
 *   - flushEpoch() does the actual tree insertions (shuffle + dummies)
 *   - borrow() signature changed: no Groth16 proof args (collateral verified via zkVerify)
 *   - CollateralVerifier, DepositVerifier, WithdrawVerifier removed
 *
 * Gas numbers are printed via console.log — check test output.
 * Tests do NOT assert limits (to avoid flakiness across chain forks).
 * Add --gas-report to forge test for tabular gas breakdown.
 */
contract GasTest is Test {
    // Required so the test contract can receive the 0.001 ETH flushEpoch tip
    receive() external payable {}

    ShieldedPool pool;
    LendingPool lendingPool;
    NullifierRegistry nullifierReg;
    ZkVerifyAggregation zkVerify;

    address deployer;
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    bytes32 constant VK_HASH = keccak256("gas_bench_withdraw_ring_vk");
    bytes32 constant COMMITMENT = bytes32(uint256(0xBEEF));
    bytes32 constant NULLIFIER_HASH = bytes32(uint256(0xCAFE));

    function setUp() public {
        deployer = address(this);
        zkVerify = new ZkVerifyAggregation(deployer);
        nullifierReg = new NullifierRegistry(address(0));
        pool = new ShieldedPool(address(nullifierReg), address(zkVerify), VK_HASH);
        nullifierReg.setShieldedPool(address(pool));
        lendingPool = new LendingPool(address(nullifierReg));
        pool.setLendingPool(address(lendingPool));
        lendingPool.setShieldedPool(address(pool));

        vm.deal(address(pool), 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // -- Benchmark: deposit (queuing only, no tree insertion) -----------------

    function test_gas_deposit() public {
        vm.prank(alice);
        uint256 before = gasleft();
        pool.deposit{value: 1 ether}(COMMITMENT);
        uint256 used = before - gasleft();
        console.log("deposit() gas (queue only):", used);
    }

    // -- Benchmark: flushEpoch (tree insertion + dummies + shuffle) -----------

    function test_gas_flushEpoch_singleDeposit() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT);

        vm.roll(block.number + 50);

        uint256 before = gasleft();
        pool.flushEpoch();
        uint256 used = before - gasleft();
        console.log("flushEpoch() gas (1 real + 10 dummies):", used);
    }

    function test_gas_flushEpoch_tenDeposits() public {
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(alice);
            pool.deposit{value: 1 ether}(bytes32(uint256(i + 1)));
        }

        vm.roll(block.number + 50);

        uint256 before = gasleft();
        pool.flushEpoch();
        uint256 used = before - gasleft();
        console.log("flushEpoch() gas (10 real + 10 dummies):", used);
    }

    // -- Benchmark: withdraw (single-leaf aggregation) ------------------------

    function test_gas_withdraw() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT);
        vm.roll(block.number + 50);
        pool.flushEpoch();

        bytes32 root = pool.getLastRoot();

        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(NULLIFIER_HASH);
        inputs[2] = uint256(uint160(alice));
        inputs[3] = 1 ether;
        bytes32 leaf = pool.statementHash(inputs);
        bytes32 aggRoot = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(0, 1, aggRoot);

        bytes32[] memory emptyPath = new bytes32[](0);

        uint256 before = gasleft();
        pool.withdraw(root, NULLIFIER_HASH, payable(alice), 1 ether, 0, 1, emptyPath, 1, 0);
        uint256 used = before - gasleft();
        console.log("withdraw() gas:", used);
    }

    // -- Benchmark: borrow ----------------------------------------------------

    function test_gas_borrow() public {
        bytes32 noteHash = bytes32(uint256(0xABCD));

        uint256 before = gasleft();
        lendingPool.borrow(noteHash, 0.7 ether, 1 ether, payable(bob));
        uint256 used = before - gasleft();
        console.log("borrow() gas:", used);
    }

    // -- Benchmark: repay -----------------------------------------------------

    function test_gas_repay() public {
        bytes32 noteHash = bytes32(uint256(0xABCD));
        lendingPool.borrow(noteHash, 0.7 ether, 1 ether, payable(bob));

        uint256 before = gasleft();
        lendingPool.repay{value: 0.7 ether}(0);
        uint256 used = before - gasleft();
        console.log("repay() gas:", used);
    }

    // -- Benchmark: submitAggregation -----------------------------------------

    function test_gas_submitAggregation() public {
        bytes32 root = keccak256("some_aggregation_root");

        uint256 before = gasleft();
        zkVerify.submitAggregation(0, 42, root);
        uint256 used = before - gasleft();
        console.log("ZkVerifyAggregation.submitAggregation() gas:", used);
    }

    // -- Benchmark: verifyProofAggregation (Merkle inclusion check) -----------

    function test_gas_verifyProofAggregation_singleLeaf() public {
        bytes32 leaf = keccak256("proof_leaf");
        bytes32 root = keccak256(abi.encodePacked(leaf));
        zkVerify.submitAggregation(0, 1, root);

        bytes32[] memory emptyPath = new bytes32[](0);

        uint256 before = gasleft();
        zkVerify.verifyProofAggregation(0, 1, leaf, emptyPath, 1, 0);
        uint256 used = before - gasleft();
        console.log("verifyProofAggregation() single-leaf gas:", used);
    }
}
