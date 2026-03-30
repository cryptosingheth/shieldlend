// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ZkVerifyAggregation} from "../src/ZkVerifyAggregation.sol";
import {CollateralVerifier} from "../src/verifiers/CollateralVerifier.sol";
import {DepositVerifier} from "../src/verifiers/DepositVerifier.sol";
import {WithdrawVerifier} from "../src/verifiers/WithdrawVerifier.sol";

/*
 * Gas Benchmarks
 *
 * Measures gas cost of the 6 key on-chain operations in ShieldLend.
 * Run with:  forge test --match-path contracts/test/Gas.t.sol -v
 *
 * Baseline targets (Base Sepolia, Feb 2026 gas prices ~0.01 gwei):
 *   deposit():            80–130k gas   ~$0.001
 *   withdraw():          180–280k gas   ~$0.003
 *   borrow():            200–280k gas   ~$0.003
 *   repay():              50–90k gas    ~$0.001
 *   verifyProof (Groth16):200–250k gas  ~$0.002  (verifier only)
 *   submitAggregation():  50–80k gas    ~$0.001
 *
 * Note: gas numbers printed via console.log — check test output for values.
 * These tests do NOT assert gas limits (to avoid flakiness across chain forks).
 * Add `--gas-report` to forge test for tabular gas breakdown.
 */
contract GasTest is Test {
    ShieldedPool pool;
    LendingPool lendingPool;
    NullifierRegistry nullifierReg;
    ZkVerifyAggregation zkVerify;
    CollateralVerifier collateralVerifier;
    DepositVerifier depositVerifier;
    WithdrawVerifier withdrawVerifier;

    address deployer;
    address alice = makeAddr("alice");

    bytes32 constant VK_HASH = keccak256("gas_bench_vk");
    bytes32 constant COMMITMENT = bytes32(uint256(0xBEEF));
    bytes32 constant NULLIFIER_HASH = bytes32(uint256(0xCAFE));

    // Real withdraw proof for benchmarking (same as Groth16Verifiers.t.sol)
    uint256[2] PA_W = [
        0x0b656b6ce3c2ef325cd22b8971c1ae3e9cdd24c8c35799e93deaaf7ed6682b1c,
        0x2171a6f39977612a824aa15a929d7e0e6892d7e4eeacbe7c57b9be6925d1c535
    ];
    uint256[2][2] PB_W = [
        [
            0x029dfda15dadd4bbe4db904b986791aa5aee9d8ec7aeae685eb7adc4d07d97ee,
            0x0e3eb5e1b5b64e77aed30b09d32a7872e209e36bcd0d0fa97b9abffa79802ee3
        ],
        [
            0x2b213a3c89442855609d946e26a88b5e26a0e3c8afc7e95f2335ea236c40380b,
            0x1ba001a19bd3fbfd7423d3525412929eb3feaa2859f07e4d1d2de864b8cc7637
        ]
    ];
    uint256[2] PC_W = [
        0x19755972d00edc8ceafeb3583380ed3b8d973fff1b5a9f047540a3288d9a8676,
        0x1de07d72d23ffe88e4bb91a94a462a52d61ea880cc8cb7964bafad51ba661fa5
    ];

    // Real collateral proof
    uint256[2] PA_C = [
        0x05b5ee78a3224fef898c4456205fbd20367e9bc826c385379718d7ad0bfb17fe,
        0x166175ab67f2548def6e64c29b236b9fabf4fd75c0b38010716b721def2b25f4
    ];
    uint256[2][2] PB_C = [
        [
            0x08fc8c3bf987d3c450b6772d1cbdddd9ae02fffbff18df79b80d5eeec54af61e,
            0x21614d6cf0b6d501fb40e5badbb0ba633cb202bf23280c5772e4cee2813fd2d7
        ],
        [
            0x081ca76ab4fdf161675e10da8a212ef57389ce0870ef947b3da49de9d6b475f7,
            0x17a64e6a64e0b9cde685a3a6310f6bd670b8a19b070364469daef25f43a374cd
        ]
    ];
    uint256[2] PC_C = [
        0x1dde7fcc0ba3ae48b95ea8163becf164be924853ec18ea9d52dc4178a6bc7e20,
        0x19ca6ed0a2f1c411531edf2d9fd33f7ded1198767012c0ee59a2f161a093f3f9
    ];

    function setUp() public {
        deployer = address(this);
        zkVerify = new ZkVerifyAggregation(deployer);
        nullifierReg = new NullifierRegistry(address(0));
        pool = new ShieldedPool(address(nullifierReg), address(zkVerify), VK_HASH);
        nullifierReg.setShieldedPool(address(pool));
        collateralVerifier = new CollateralVerifier();
        depositVerifier = new DepositVerifier();
        withdrawVerifier = new WithdrawVerifier();
        lendingPool = new LendingPool(address(pool), address(nullifierReg), address(collateralVerifier));
        vm.deal(address(lendingPool), 100 ether);
        vm.deal(alice, 100 ether);
    }

    // ── Benchmark: deposit ────────────────────────────────────────────────────

    function test_gas_deposit() public {
        vm.prank(alice);
        uint256 before = gasleft();
        pool.deposit{value: 1 ether}(COMMITMENT);
        uint256 used = before - gasleft();
        console.log("deposit() gas:", used);
    }

    // ── Benchmark: withdraw (with single-leaf aggregation) ────────────────────

    function test_gas_withdraw() public {
        vm.prank(alice);
        pool.deposit{value: 1 ether}(COMMITMENT);

        bytes32 root = pool.getLastRoot();

        // Build the statement leaf matching ShieldedPool._verifyAttestation
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

    // ── Benchmark: borrow ─────────────────────────────────────────────────────

    function test_gas_borrow() public {
        bytes32 noteHash = bytes32(uint256(0xABCD));

        vm.prank(alice);
        uint256 before = gasleft();
        lendingPool.borrow(PA_C, PB_C, PC_C, noteHash, 1000, payable(alice), 0);
        uint256 used = before - gasleft();
        console.log("borrow() gas:", used);
    }

    // ── Benchmark: repay ──────────────────────────────────────────────────────

    function test_gas_repay() public {
        bytes32 noteHash = bytes32(uint256(0xABCD));
        vm.prank(alice);
        lendingPool.borrow(PA_C, PB_C, PC_C, noteHash, 1000, payable(alice), 0);

        uint256 before = gasleft();
        lendingPool.repay{value: 1000}(0);
        uint256 used = before - gasleft();
        console.log("repay() gas:", used);
    }

    // ── Benchmark: Groth16 verifyProof (withdraw verifier only) ──────────────

    function test_gas_groth16_verifyProof_withdraw() public view {
        uint256[4] memory pub = [
            0x27a838833c6fbb3b6b045366db4ab4fe9ab8345d4122937a4379d7dbd76a8bff,
            0x15e57b5244f1786e69d887cf6ebc5e2b25f3fc0b7520583029bc377982a66536,
            0x0000000000000000000000000000000000000000000000000000000000bc614e,
            0x00000000000000000000000000000000000000000000000000000000000003e8
        ];

        uint256 before = gasleft();
        withdrawVerifier.verifyProof(PA_W, PB_W, PC_W, pub);
        uint256 used = before - gasleft();
        console.log("WithdrawVerifier.verifyProof() gas:", used);
    }

    // ── Benchmark: submitAggregation ─────────────────────────────────────────

    function test_gas_submitAggregation() public {
        bytes32 root = keccak256("some_aggregation_root");

        uint256 before = gasleft();
        zkVerify.submitAggregation(0, 42, root);
        uint256 used = before - gasleft();
        console.log("ZkVerifyAggregation.submitAggregation() gas:", used);
    }

    // ── Benchmark: verifyProofAggregation (Merkle inclusion check) ───────────

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
