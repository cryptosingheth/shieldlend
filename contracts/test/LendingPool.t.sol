// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";

/*
 * LendingPool V2 Tests
 *
 * V2 changes covered:
 *   - No ETH custody in LendingPool (disbursement via ShieldedPool.disburseLoan)
 *   - Aave v3 two-slope utilization interest rate model
 *   - Liquidation with health factor threshold
 *   - Collateral locking: lockNullifier() called on ShieldedPool at borrow time
 *   - Disbursement: disburseLoan() called on ShieldedPool at borrow time
 *   - settleCollateral(): only callable by ShieldedPool
 *   - getOwed(): returns principal + accrued interest
 *   - Borrowed event emits only loanId (privacy: no amount or recipient)
 */

/// @dev Mock ShieldedPool: records lockNullifier and disburseLoan calls.
contract MockShieldedPool {
    mapping(bytes32 => bool) public locked;
    address public lastDisbursedRecipient;
    uint256 public lastDisbursedAmount;
    uint256 public totalDisbursed;

    receive() external payable {}

    function lockNullifier(bytes32 n) external {
        locked[n] = true;
    }

    function unlockNullifier(bytes32 n) external {
        locked[n] = false;
    }

    function disburseLoan(address payable recipient, uint256 amount) external {
        lastDisbursedRecipient = recipient;
        lastDisbursedAmount = amount;
        totalDisbursed += amount;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "MockSP: disbursement failed");
    }
}

contract LendingPoolTest is Test {
    LendingPool lendingPool;
    MockShieldedPool mockSP;
    NullifierRegistry nullifierReg;

    address deployer;
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    address carol = makeAddr("carol");

    bytes32 constant NOTE_HASH_1 = bytes32(uint256(0xC0FFEE01));
    bytes32 constant NOTE_HASH_2 = bytes32(uint256(0xC0FFEE02));

    // 70% of 1 ETH collateral — within MIN_HEALTH_FACTOR (110%)
    // collateral=1e18, borrowed=0.7e18: 1e18*10000 >= 0.7e18*11000 -> 1e22 >= 7.7e21 pass
    uint256 constant COLLATERAL = 1 ether;
    uint256 constant BORROWED   = 0.7 ether;

    function setUp() public {
        deployer = address(this);
        nullifierReg = new NullifierRegistry(address(0));

        lendingPool = new LendingPool(address(nullifierReg));

        mockSP = new MockShieldedPool();
        vm.deal(address(mockSP), 10 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob,   100 ether);
        vm.deal(carol, 100 ether);

        lendingPool.setShieldedPool(address(mockSP));
        // alice is the operator (simulates the backend wallet that runs zkVerify)
        lendingPool.setOperator(alice);
    }

    // -- Borrow: happy path ---------------------------------------------------

    function testBorrow_locksNullifier() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        assertTrue(mockSP.locked(NOTE_HASH_1), "lockNullifier must be called on ShieldedPool");
    }

    function testBorrow_disburses() public {
        uint256 bobBefore = bob.balance;
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        assertEq(mockSP.lastDisbursedRecipient(), bob, "disburseLoan recipient must be bob");
        assertEq(mockSP.lastDisbursedAmount(), BORROWED, "disburseLoan amount must match borrowed");
        assertEq(bob.balance, bobBefore + BORROWED, "Bob should receive borrowed ETH");
    }

    function testBorrow_recordsLoan() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        (
            bytes32 collHash,
            uint256 borrowed,
            ,
            uint256 totalOwed,
            bool repaid
        ) = lendingPool.getLoanDetails(1);

        assertEq(collHash, NOTE_HASH_1);
        assertEq(borrowed, BORROWED);
        assertEq(totalOwed, BORROWED); // no time elapsed = no interest
        assertFalse(repaid);
    }

    function testBorrow_emitsOnlyLoanId() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, false);
        emit LendingPool.Borrowed(1);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));
    }

    function testBorrow_incrementsLoanId() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));
        assertEq(lendingPool.nextLoanId(), 2);

        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_2, BORROWED, COLLATERAL, payable(bob));
        assertEq(lendingPool.nextLoanId(), 3);
    }

    function testBorrow_tracksTotalBorrowed() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));
        assertEq(lendingPool.totalBorrowed(), BORROWED);

        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_2, BORROWED, COLLATERAL, payable(carol));
        assertEq(lendingPool.totalBorrowed(), BORROWED * 2);
    }

    // -- Borrow: unhappy paths ------------------------------------------------

    function testBorrow_reverts_noteAlreadyUsed() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(alice);
        vm.expectRevert(LendingPool.NoteAlreadyUsedAsCollateral.selector);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(carol));
    }

    function testBorrow_reverts_insufficientCollateral() public {
        // MIN_HEALTH_FACTOR_BPS = 11000 -> max borrow = collateral * 10000 / 11000 ~ 0.909 ETH
        uint256 tooMuch = 0.95 ether;
        vm.prank(alice);
        vm.expectRevert(bytes("Insufficient collateral"));
        lendingPool.borrow(NOTE_HASH_1, tooMuch, COLLATERAL, payable(bob));
    }

    // -- getOwed --------------------------------------------------------------

    function testGetOwed_zeroAtBorrowTime() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        assertEq(lendingPool.getOwed(NOTE_HASH_1), BORROWED, "No interest at t=0");
    }

    function testGetOwed_accruedAfterTime() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.warp(block.timestamp + 365 days);
        assertTrue(lendingPool.getOwed(NOTE_HASH_1) > BORROWED, "Interest should accrue");
    }

    function testGetOwed_zeroForRepaidLoan() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(bob);
        lendingPool.repay{value: BORROWED}(1);

        assertEq(lendingPool.getOwed(NOTE_HASH_1), 0);
    }

    // -- Interest rate model --------------------------------------------------

    function testUtilizationRate_zeroWhenNoBorrows() public view {
        assertEq(lendingPool.totalBorrowed(), 0);
    }

    function testKinkRate_belowOptimal() public {
        // mockSP has 10 ETH; borrow 4 ETH -> util = 40% (below 80% kink)
        // collateral needs >= 4e18 * 11000 / 10000 = 4.4 ETH
        uint256 borrowAmt = 4 ether;
        uint256 collateralAmt = 5 ether;
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, borrowAmt, collateralAmt, payable(bob));

        vm.warp(block.timestamp + 365 days);
        (, uint256 borrowed, uint256 interest, , ) = lendingPool.getLoanDetails(1);

        // Below kink: rate = 100 + (4000 * 400 / 8000) = 100 + 200 = 300 bps = 3% APY
        uint256 expectedInterest = (borrowed * 300) / 10000;
        assertApproxEqRel(interest, expectedInterest, 0.1e18);
    }

    function testKinkRate_aboveOptimal() public {
        // mockSP has 10 ETH; borrow 9 ETH -> util = 90% (above 80% kink)
        // collateral needs >= 9e18 * 11000 / 10000 = 9.9 ETH
        uint256 borrowAmt = 9 ether;
        uint256 collateralAmt = 10 ether;
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, borrowAmt, collateralAmt, payable(bob));

        vm.warp(block.timestamp + 365 days);
        (, uint256 borrowed, uint256 interest, , ) = lendingPool.getLoanDetails(1);

        // Above kink: rate = 100 + 400 + (1000 * 4000 / 2000) = 2500 bps = 25% APY
        uint256 expectedInterest = (borrowed * 2500) / 10000;
        assertApproxEqRel(interest, expectedInterest, 0.1e18);
    }

    // -- settleCollateral -----------------------------------------------------

    function testSettleCollateral_onlyShieldedPool() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(alice);
        vm.expectRevert(LendingPool.NotShieldedPool.selector);
        lendingPool.settleCollateral{value: BORROWED}(NOTE_HASH_1);
    }

    function testSettleCollateral_clearsLoan() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(address(mockSP));
        lendingPool.settleCollateral{value: BORROWED}(NOTE_HASH_1);

        assertFalse(lendingPool.hasActiveLoan(NOTE_HASH_1), "Loan should be cleared");
        assertEq(lendingPool.totalBorrowed(), 0, "totalBorrowed should decrease");
    }

    function testSettleCollateral_emitsRepaid() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(address(mockSP));
        vm.expectEmit(true, false, false, false);
        emit LendingPool.Repaid(1, BORROWED);
        lendingPool.settleCollateral{value: BORROWED}(NOTE_HASH_1);
    }

    // -- Repay ----------------------------------------------------------------

    function testRepay_closesLoan() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(bob);
        lendingPool.repay{value: BORROWED}(1);

        (, , , , bool repaid) = lendingPool.getLoanDetails(1);
        assertTrue(repaid);
        assertFalse(lendingPool.hasActiveLoan(NOTE_HASH_1));
    }

    function testRepay_overpaymentRefunded() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        uint256 carolBefore = carol.balance;
        vm.prank(carol);
        lendingPool.repay{value: BORROWED + 0.1 ether}(1);

        assertEq(carol.balance, carolBefore - BORROWED);
    }

    function testRepay_reverts_notFound() public {
        vm.prank(alice);
        vm.expectRevert(LendingPool.LoanNotFound.selector);
        lendingPool.repay{value: BORROWED}(999);
    }

    function testRepay_reverts_alreadyRepaid() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(bob);
        lendingPool.repay{value: BORROWED}(1);

        vm.prank(bob);
        vm.expectRevert(LendingPool.LoanAlreadyRepaid.selector);
        lendingPool.repay{value: BORROWED}(1);
    }

    function testRepay_reverts_underpayment() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(bob);
        vm.expectRevert(LendingPool.InsufficientRepayment.selector);
        lendingPool.repay{value: BORROWED - 1}(1);
    }

    // -- Liquidation ----------------------------------------------------------

    function testCanLiquidate_falseInitially() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));
        assertFalse(lendingPool.canLiquidate(1));
    }

    function testCanLiquidate_trueWhenUnderwater() public {
        // Borrow at edge: collateral=1 ETH, borrowed=0.9 ETH
        // LIQUIDATION_THRESHOLD=9000 -> collateral*9000/10000 = 0.9 ETH
        // At t=0: owed=0.9 ETH, threshold value=0.9 ETH -> not liquidatable (< not <)
        // After 2 years of interest: owed > 0.9 ETH -> liquidatable
        uint256 edgeBorrow = 0.9 ether;
        uint256 edgeCollateral = 1 ether;
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, edgeBorrow, edgeCollateral, payable(bob));

        vm.warp(block.timestamp + 365 days * 2);
        assertTrue(lendingPool.canLiquidate(1));
    }

    function testCanLiquidate_falseForRepaidLoan() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(bob);
        lendingPool.repay{value: BORROWED}(1);

        assertFalse(lendingPool.canLiquidate(1));
    }

    function testLiquidate_whenLiquidatable() public {
        uint256 edgeBorrow = 0.9 ether;
        uint256 edgeCollateral = 1 ether;
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, edgeBorrow, edgeCollateral, payable(bob));

        vm.warp(block.timestamp + 365 days * 2);
        require(lendingPool.canLiquidate(1), "Setup: must be liquidatable");

        uint256 owed = lendingPool.getOwed(NOTE_HASH_1);

        vm.prank(carol);
        lendingPool.liquidate{value: owed}(1);

        assertFalse(lendingPool.hasActiveLoan(NOTE_HASH_1));
        assertEq(lendingPool.totalBorrowed(), 0);
    }

    function testLiquidate_unlocksCollateral() public {
        // C-2 fix: liquidate must call unlockNullifier on ShieldedPool
        uint256 edgeBorrow = 0.9 ether;
        uint256 edgeCollateral = 1 ether;
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, edgeBorrow, edgeCollateral, payable(bob));
        assertTrue(mockSP.locked(NOTE_HASH_1), "Note should be locked after borrow");

        vm.warp(block.timestamp + 365 days * 2);
        uint256 owed = lendingPool.getOwed(NOTE_HASH_1);
        vm.prank(carol);
        lendingPool.liquidate{value: owed}(1);

        assertFalse(mockSP.locked(NOTE_HASH_1), "Note must be unlocked after liquidation");
    }

    function testLiquidate_reverts_whenHealthy() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.prank(carol);
        vm.expectRevert(bytes("Not liquidatable"));
        lendingPool.liquidate{value: BORROWED}(1);
    }

    // -- Operator access control (C-1 fix) ------------------------------------

    function testBorrow_reverts_nonOperator() public {
        vm.prank(carol); // carol is not operator
        vm.expectRevert(LendingPool.NotOperator.selector);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));
    }

    function testSetOperator_onlyAdmin() public {
        vm.prank(alice);
        vm.expectRevert(LendingPool.NotAdmin.selector);
        lendingPool.setOperator(carol);
    }

    // -- Admin ----------------------------------------------------------------

    function testSetShieldedPool_onlyAdmin() public {
        vm.prank(alice);
        vm.expectRevert(LendingPool.NotAdmin.selector);
        lendingPool.setShieldedPool(alice);
    }

    function testSetShieldedPool_byAdmin() public {
        lendingPool.setShieldedPool(alice);
        assertEq(lendingPool.shieldedPool(), alice);
    }

    // -- getLoanDetails -------------------------------------------------------

    function testGetLoanDetails_nonExistent() public view {
        (bytes32 hash, uint256 borrowed, uint256 interest, uint256 total, bool repaid) =
            lendingPool.getLoanDetails(999);
        assertEq(hash, bytes32(0));
        assertEq(borrowed, 0);
        assertEq(interest, 0);
        assertEq(total, 0);
        assertFalse(repaid);
    }

    function testGetLoanDetails_afterBorrow() public {
        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        vm.warp(block.timestamp + 365 days);
        (, uint256 borrowed, uint256 interest, uint256 totalOwed, bool repaid) =
            lendingPool.getLoanDetails(1);

        assertEq(borrowed, BORROWED);
        assertTrue(interest > 0, "Interest should accrue");
        assertEq(totalOwed, borrowed + interest);
        assertFalse(repaid);
    }

    // -- Fuzz -----------------------------------------------------------------

    function testFuzz_repay_overpaymentAlwaysRefunded(uint96 overpay) public {
        vm.assume(overpay > 0 && overpay < 10 ether);

        vm.prank(alice);
        lendingPool.borrow(NOTE_HASH_1, BORROWED, COLLATERAL, payable(bob));

        uint256 carolBefore = carol.balance;
        vm.prank(carol);
        lendingPool.repay{value: BORROWED + uint256(overpay)}(1);

        assertEq(carol.balance, carolBefore - BORROWED);
    }
}
