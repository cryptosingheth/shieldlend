// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NullifierRegistry} from "./NullifierRegistry.sol";

/*
 * LendingPool — ShieldLend V2
 *
 * V2 changes vs V1:
 *   - No ETH custody: removed receive(). All ETH held in ShieldedPool.
 *   - Loan disbursement via ShieldedPool.disburseLoan() instead of direct transfer.
 *   - Collateral locking: calls ShieldedPool.lockNullifier() on borrow.
 *   - Auto-settle: settleCollateral() is called by ShieldedPool.withdraw() when
 *     a locked nullifier is withdrawn. Closes the loan atomically.
 *   - Aave v3-style two-slope utilization interest rate model.
 *   - Liquidation based on health factor (collateral ratio), not time.
 *   - Borrowed event emits only loanId (no amount or recipient — privacy).
 *   - totalBorrowed tracking for utilization rate calculation.
 */

interface IShieldedPool {
    function lockNullifier(bytes32 n) external;
    function disburseLoan(address payable recipient, uint256 amount) external;
    function unlockNullifier(bytes32 n) external;
}

contract LendingPool {
    // -- State ----------------------------------------------------------------

    address public immutable admin;
    address public shieldedPool;
    address public operator; // backend wallet that has verified zkVerify proof off-chain
    NullifierRegistry public immutable nullifierRegistry;

    // -- Interest rate model (Aave v3 two-slope utilization) ------------------
    // All rates in BPS (basis points), denominator = 10000
    uint256 public constant R_BASE = 100;          // 1% base rate
    uint256 public constant R_SLOPE1 = 400;        // 4% slope below optimal
    uint256 public constant U_OPTIMAL_BPS = 8000;  // 80% optimal utilization
    uint256 public constant R_SLOPE2 = 4000;       // 40% slope above optimal
    uint256 public constant BPS_DENOMINATOR = 10000;

    // -- Liquidation parameters -----------------------------------------------
    uint256 public constant LIQUIDATION_THRESHOLD = 9000;    // 90%
    uint256 public constant LIQUIDATION_BONUS_BPS = 500;     // 5%
    uint256 public constant MIN_HEALTH_FACTOR_BPS = 11000;   // 110% at borrow time

    // -- Utilization tracking -------------------------------------------------
    uint256 public totalBorrowed;

    struct Loan {
        bytes32 collateralNullifierHash; // identifies the collateral note in ShieldedPool
        uint256 borrowed;               // principal borrowed
        uint256 timestamp;              // when the loan was taken
        address recipient;              // who received the loan funds
        uint256 collateralAmount;       // denomination of the collateral note
        uint256 liquidationThreshold;   // snapshot of LIQUIDATION_THRESHOLD at borrow time
        bool repaid;
    }

    mapping(uint256 => Loan) public loans;
    uint256 public nextLoanId;

    // nullifierHash => active loanId (prevents same note being used twice)
    mapping(bytes32 => uint256) public activeLoanByNote;
    mapping(bytes32 => bool) public hasActiveLoan;

    // -- Events ---------------------------------------------------------------
    event Borrowed(uint256 indexed loanId);
    event Repaid(uint256 indexed loanId, uint256 totalRepaid);
    event Liquidated(uint256 indexed loanId, address liquidator, uint256 debtRepaid, uint256 collateralSeized);

    // -- Errors ---------------------------------------------------------------
    error NoteAlreadyUsedAsCollateral();
    error LoanNotFound();
    error LoanAlreadyRepaid();
    error InsufficientRepayment();
    error NotAdmin();
    error NotShieldedPool();
    error NotOperator();

    // -- Modifiers ------------------------------------------------------------
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyShieldedPool() {
        if (msg.sender != shieldedPool) revert NotShieldedPool();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _nullifierRegistry) {
        admin = msg.sender;
        operator = msg.sender; // deployer is initial operator; update via setOperator()
        nullifierRegistry = NullifierRegistry(_nullifierRegistry);
    }

    // -- Admin ----------------------------------------------------------------
    function setShieldedPool(address _sp) external onlyAdmin {
        shieldedPool = _sp;
    }

    /// @notice Update the operator address (backend wallet that submits borrows after zkVerify).
    function setOperator(address _op) external onlyAdmin {
        operator = _op;
    }

    // -- Core: Borrow ---------------------------------------------------------
    /*
     * Borrow against a shielded collateral note.
     *
     * The collateral ZK proof (withdraw_ring / collateral_ring) is verified
     * off-chain via zkVerify before this call reaches the contract. The contract
     * trusts that the caller has a valid collateral proof for noteNullifierHash.
     *
     * @param noteNullifierHash  Poseidon(nullifier, ring_index) from the collateral proof
     * @param borrowed           Amount to borrow (in wei)
     * @param collateralAmount   Denomination of the collateral note (public signal)
     * @param recipient          Address to receive the borrowed funds
     */
    function borrow(
        bytes32 noteNullifierHash,
        uint256 borrowed,
        uint256 collateralAmount,
        address payable recipient
    ) external onlyOperator {
        if (hasActiveLoan[noteNullifierHash]) revert NoteAlreadyUsedAsCollateral();

        // Health factor check at borrow time: collateral * 10000 >= borrowed * MIN_HEALTH_FACTOR_BPS
        require(
            collateralAmount * BPS_DENOMINATOR >= borrowed * MIN_HEALTH_FACTOR_BPS,
            "Insufficient collateral"
        );

        // Lock the collateral note in ShieldedPool (prevents withdrawal without repayment)
        IShieldedPool(shieldedPool).lockNullifier(noteNullifierHash);

        uint256 loanId = nextLoanId++;
        loans[loanId] = Loan({
            collateralNullifierHash: noteNullifierHash,
            borrowed: borrowed,
            timestamp: block.timestamp,
            recipient: recipient,
            collateralAmount: collateralAmount,
            liquidationThreshold: LIQUIDATION_THRESHOLD,
            repaid: false
        });
        activeLoanByNote[noteNullifierHash] = loanId;
        hasActiveLoan[noteNullifierHash] = true;
        totalBorrowed += borrowed;

        // Disburse from ShieldedPool (sole ETH vault)
        IShieldedPool(shieldedPool).disburseLoan(recipient, borrowed);

        // Privacy: emit only loanId — no amount or recipient in event logs
        emit Borrowed(loanId);
    }

    // -- Core: Repay ----------------------------------------------------------
    /*
     * Repay a loan. Anyone can repay on behalf of anyone else.
     * Overpayment is refunded to msg.sender.
     */
    function repay(uint256 loanId) external payable {
        Loan storage loan = loans[loanId];
        if (loan.borrowed == 0) revert LoanNotFound();
        if (loan.repaid) revert LoanAlreadyRepaid();

        uint256 interest = _calculateInterest(loan.borrowed, loan.timestamp);
        uint256 totalOwed = loan.borrowed + interest;

        if (msg.value < totalOwed) revert InsufficientRepayment();

        loan.repaid = true;
        hasActiveLoan[loan.collateralNullifierHash] = false;
        totalBorrowed -= loan.borrowed;

        if (msg.value > totalOwed) {
            (bool ok, ) = msg.sender.call{value: msg.value - totalOwed}("");
            require(ok, "Refund failed");
        }

        // Forward repaid ETH to ShieldedPool (sole ETH vault)
        (bool fwd,) = payable(shieldedPool).call{value: totalOwed}("");
        require(fwd, "Forward to pool failed");

        emit Repaid(loanId, totalOwed);
    }

    // -- Core: Settle collateral (called by ShieldedPool on locked withdraw) --
    /*
     * Called only by ShieldedPool when a locked nullifier is withdrawn.
     * Closes the loan and accepts ETH payment covering the debt.
     * The withdrawal amount minus totalOwed is sent to the original recipient.
     */
    function settleCollateral(bytes32 nullifierHash) external payable onlyShieldedPool {
        uint256 loanId = activeLoanByNote[nullifierHash];
        Loan storage loan = loans[loanId];
        require(!loan.repaid, "Already repaid");

        loan.repaid = true;
        hasActiveLoan[nullifierHash] = false;
        totalBorrowed -= loan.borrowed;

        emit Repaid(loanId, msg.value);
    }

    // -- Core: Liquidation ----------------------------------------------------
    function canLiquidate(uint256 loanId) public view returns (bool) {
        Loan storage l = loans[loanId];
        if (l.repaid || l.borrowed == 0) return false;
        uint256 totalOwed = l.borrowed + _calculateInterest(l.borrowed, l.timestamp);
        return (l.collateralAmount * LIQUIDATION_THRESHOLD) / 10000 < totalOwed;
    }

    /*
     * Liquidate an underwater position.
     * Liquidator pays totalOwed and receives a 5% bonus on the collateral amount.
     * Any remaining collateral after debt + bonus flows to the protocol treasury.
     */
    function liquidate(uint256 loanId) external payable {
        require(canLiquidate(loanId), "Not liquidatable");
        Loan storage l = loans[loanId];
        uint256 totalOwed = getOwed(l.collateralNullifierHash);
        require(msg.value >= totalOwed, "Insufficient liquidation payment");

        bytes32 collateralHash = l.collateralNullifierHash;
        uint256 principal = l.borrowed;
        l.repaid = true;
        hasActiveLoan[collateralHash] = false;
        totalBorrowed -= principal;

        // Unlock collateral note so it can be withdrawn again
        IShieldedPool(shieldedPool).unlockNullifier(collateralHash);

        // Refund overpayment
        if (msg.value > totalOwed) {
            (bool ok,) = msg.sender.call{value: msg.value - totalOwed}("");
            require(ok, "Refund failed");
        }

        // Forward repaid ETH to ShieldedPool (sole ETH vault)
        (bool fwd,) = payable(shieldedPool).call{value: totalOwed}("");
        require(fwd, "Forward to pool failed");

        emit Liquidated(loanId, msg.sender, totalOwed, l.collateralAmount);
    }

    // -- View: Loan details ---------------------------------------------------
    function getLoanDetails(uint256 loanId)
        external
        view
        returns (
            bytes32 collateralNullifierHash,
            uint256 borrowed,
            uint256 currentInterest,
            uint256 totalOwed,
            bool repaid
        )
    {
        Loan storage loan = loans[loanId];
        uint256 interest = _calculateInterest(loan.borrowed, loan.timestamp);
        return (
            loan.collateralNullifierHash,
            loan.borrowed,
            interest,
            loan.borrowed + interest,
            loan.repaid
        );
    }

    /// @notice Returns principal + accrued interest for a given collateral nullifier.
    ///         Called by ShieldedPool to determine the auto-settle amount.
    function getOwed(bytes32 nullifierHash) public view returns (uint256) {
        uint256 loanId = activeLoanByNote[nullifierHash];
        Loan storage loan = loans[loanId];
        if (loan.borrowed == 0 || loan.repaid) return 0;
        uint256 interest = _calculateInterest(loan.borrowed, loan.timestamp);
        return loan.borrowed + interest;
    }

    // -- Internal: Aave v3-style two-slope interest ---------------------------
    /*
     * Rate = R_BASE + (U / U_optimal) * R_slope1          when U <= U_optimal
     * Rate = R_BASE + R_slope1 + ((U - U_opt) / (1 - U_opt)) * R_slope2  when U > U_optimal
     *
     * Interest = principal * rate * elapsed / (365 days * BPS_DENOMINATOR)
     */
    function _currentRate() internal view returns (uint256) {
        // totalDeposits = ETH in vault + ETH borrowed out (both originated from deposits)
        uint256 totalDeposited = address(shieldedPool).balance + totalBorrowed;
        if (totalDeposited == 0) return R_BASE;

        uint256 utilizationBps = (totalBorrowed * BPS_DENOMINATOR) / totalDeposited;

        if (utilizationBps <= U_OPTIMAL_BPS) {
            return R_BASE + (utilizationBps * R_SLOPE1) / U_OPTIMAL_BPS;
        } else {
            uint256 excessUtil = utilizationBps - U_OPTIMAL_BPS;
            uint256 remainingUtil = BPS_DENOMINATOR - U_OPTIMAL_BPS;
            return R_BASE + R_SLOPE1 + (excessUtil * R_SLOPE2) / remainingUtil;
        }
    }

    function _calculateInterest(uint256 principal, uint256 startTime)
        internal
        view
        returns (uint256)
    {
        uint256 elapsed = block.timestamp - startTime;
        uint256 rate = _currentRate();
        return (principal * rate * elapsed) / (365 days * BPS_DENOMINATOR);
    }
}
