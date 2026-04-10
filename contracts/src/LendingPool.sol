// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NullifierRegistry} from "./NullifierRegistry.sol";

/*
 * LendingPool — ShieldLend V2A
 *
 * V2A changes vs V2:
 *   - Multi-shard: replaces single shieldedPool with a shard registry.
 *     isRegisteredShard[addr] tracks registered ShieldedPool shards.
 *   - Cross-shard borrow: collateralShard (note locked here) and disburseShard
 *     (ETH disbursed from here) can differ. Server picks the richest shard.
 *   - Cross-shard repay/liquidate: ETH forwarded to disburseShard.
 *   - Interest rate: sums ETH across ALL registered shards for utilization.
 *   - Global root registry: each shard pushes its new Merkle root here.
 *     ShieldedPool.withdraw() checks this registry for cross-shard proofs.
 *   - Aave v3-style two-slope utilization interest rate model (unchanged).
 *   - Liquidation based on health factor (unchanged).
 *
 * V2 changes vs V1 (still applicable):
 *   - No ETH custody: all ETH held in ShieldedPool shards.
 *   - Loan disbursement via ShieldedPool.disburseLoan().
 *   - Collateral locking: calls ShieldedPool.lockNullifier() on borrow.
 *   - Auto-settle: settleCollateral() called by ShieldedPool on locked withdraw.
 *   - Borrowed event emits only loanId (no amount or recipient — privacy).
 *   - totalBorrowed tracking for utilization rate calculation.
 */

interface IShieldedPool {
    function lockNullifier(bytes32 n) external;
    function disburseLoan(address payable recipient, uint256 amount) external;
    function unlockNullifier(bytes32 n) external;
    function getLastRoot() external view returns (bytes32);
}

contract LendingPool {
    // -- State ----------------------------------------------------------------

    address public immutable admin;
    address public operator; // backend wallet that has verified zkVerify proof off-chain
    NullifierRegistry public immutable nullifierRegistry;

    // -- Multi-shard registry -------------------------------------------------
    // Replaces single `shieldedPool` address from V2.
    mapping(address => bool) public isRegisteredShard;
    address[] public registeredShards;
    address internal _defaultShard; // set by setShieldedPool() for single-shard compat

    // -- Global root registry (enables cross-shard withdrawal) ----------------
    // Each shard calls pushRoot() after every Merkle insertion.
    // ShieldedPool.withdraw() accepts roots from this registry in addition to
    // its own local root history.
    mapping(bytes32 => bool) public isValidRoot;

    // -- Interest rate model (Aave v3 two-slope utilization) ------------------
    uint256 public constant R_BASE = 100;
    uint256 public constant R_SLOPE1 = 400;
    uint256 public constant U_OPTIMAL_BPS = 8000;
    uint256 public constant R_SLOPE2 = 4000;
    uint256 public constant BPS_DENOMINATOR = 10000;

    // -- Liquidation parameters -----------------------------------------------
    uint256 public constant LIQUIDATION_THRESHOLD = 9000;
    uint256 public constant LIQUIDATION_BONUS_BPS = 500;
    uint256 public constant MIN_HEALTH_FACTOR_BPS = 11000;

    // -- Utilization tracking -------------------------------------------------
    uint256 public totalBorrowed;

    struct Loan {
        bytes32 collateralNullifierHash;
        uint256 borrowed;
        uint256 timestamp;
        address recipient;
        uint256 collateralAmount;
        uint256 liquidationThreshold;
        bool repaid;
        address collateralShard; // shard where the note is locked as collateral
        address disburseShard;   // shard that disbursed the ETH (repayment goes here)
    }

    mapping(uint256 => Loan) public loans;
    uint256 public nextLoanId;

    mapping(bytes32 => uint256) public activeLoanByNote;
    mapping(bytes32 => bool) public hasActiveLoan;

    // -- Events ---------------------------------------------------------------
    event Borrowed(uint256 indexed loanId);
    event Repaid(uint256 indexed loanId, uint256 totalRepaid);
    event Liquidated(uint256 indexed loanId, address liquidator, uint256 debtRepaid, uint256 collateralSeized);
    event ShardRegistered(address shard);

    // -- Errors ---------------------------------------------------------------
    error NoteAlreadyUsedAsCollateral();
    error LoanNotFound();
    error LoanAlreadyRepaid();
    error InsufficientRepayment();
    error NotAdmin();
    error NotShieldedPool();
    error NotOperator();
    error UnknownShard();

    // -- Reentrancy guard (inline — no OZ dependency) -------------------------
    uint256 private _reentrancyStatus = 1;
    modifier nonReentrant() {
        require(_reentrancyStatus == 1, "ReentrancyGuard: reentrant call");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    // -- Modifiers ------------------------------------------------------------
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyShieldedPool() {
        if (!isRegisteredShard[msg.sender]) revert NotShieldedPool();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _nullifierRegistry) {
        admin = msg.sender;
        operator = msg.sender;
        nullifierRegistry = NullifierRegistry(_nullifierRegistry);
        // Start at 1 so loan ID 0 is never a real loan.
        // activeLoanByNote defaults to 0 for unmapped keys — starting nextLoanId at 1
        // makes it impossible to confuse "no loan" (0) with "loan ID 0" (invalid).
        nextLoanId = 1;
    }

    // -- Admin ----------------------------------------------------------------

    function registerShard(address shard) external onlyAdmin {
        _registerShard(shard);
    }

    /// @notice Backwards-compatible alias: registers the shard AND records it as
    ///         the default for single-shard deployments and tests.
    function setShieldedPool(address shard) external onlyAdmin {
        _registerShard(shard);
        _defaultShard = shard;
    }

    /// @notice Returns the default (first / only) registered shard.
    ///         Used by tests and single-shard deployments.
    function shieldedPool() external view returns (address) {
        return _defaultShard;
    }

    function _registerShard(address shard) internal {
        if (!isRegisteredShard[shard]) {
            isRegisteredShard[shard] = true;
            registeredShards.push(shard);
            emit ShardRegistered(shard);
        }
    }

    /// @notice Convenience helper: register multiple shards from a factory in one call.
    function registerShards(address[] calldata shardList) external onlyAdmin {
        for (uint256 i = 0; i < shardList.length; i++) {
            if (!isRegisteredShard[shardList[i]]) {
                isRegisteredShard[shardList[i]] = true;
                registeredShards.push(shardList[i]);
                emit ShardRegistered(shardList[i]);
            }
        }
    }

    function setOperator(address _op) external onlyAdmin {
        operator = _op;
    }

    // -- Global root registry (called by each shard after _insert) -----------

    /// @notice Shard pushes its new Merkle root here so other shards can
    ///         verify cross-shard withdrawal proofs.
    /// @dev Root is validated against the shard's own getLastRoot() to prevent
    ///      arbitrary root injection. Called by ShieldedPool._insert() immediately
    ///      after updating currentRoot, so getLastRoot() == root at call time.
    function pushRoot(bytes32 root) external {
        if (!isRegisteredShard[msg.sender]) revert NotShieldedPool();
        // Validate: the pushed root must be the shard's actual current Merkle root.
        // Prevents a compromised shard from injecting a fabricated root.
        require(root == IShieldedPool(msg.sender).getLastRoot(), "Root mismatch");
        isValidRoot[root] = true;
    }

    // -- Core: Borrow ---------------------------------------------------------

    /// @notice Backwards-compatible 4-param borrow using the default shard.
    ///         Equivalent to calling borrow(hash, borrowed, collateral, recipient, _defaultShard, _defaultShard).
    function borrow(
        bytes32 noteNullifierHash,
        uint256 borrowed,
        uint256 collateralAmount,
        address payable recipient
    ) external onlyOperator {
        require(_defaultShard != address(0), "No default shard set");
        _borrow(noteNullifierHash, borrowed, collateralAmount, recipient, _defaultShard, _defaultShard);
    }

    /*
     * Borrow against a shielded collateral note.
     *
     * collateralShard: which shard holds the note (its nullifier is locked here)
     * disburseShard:   which shard to draw ETH from (server picks richest)
     *
     * Having two shard params enables cross-shard liquidity routing:
     * the collateral can be in a low-liquidity shard while borrowing from a
     * high-liquidity shard, preventing borrow failures due to shard fragmentation.
     */
    function borrow(
        bytes32 noteNullifierHash,
        uint256 borrowed,
        uint256 collateralAmount,
        address payable recipient,
        address collateralShard,
        address disburseShard
    ) external onlyOperator {
        _borrow(noteNullifierHash, borrowed, collateralAmount, recipient, collateralShard, disburseShard);
    }

    function _borrow(
        bytes32 noteNullifierHash,
        uint256 borrowed,
        uint256 collateralAmount,
        address payable recipient,
        address collateralShard,
        address disburseShard
    ) internal {
        if (!isRegisteredShard[collateralShard]) revert UnknownShard();
        if (!isRegisteredShard[disburseShard]) revert UnknownShard();
        if (hasActiveLoan[noteNullifierHash]) revert NoteAlreadyUsedAsCollateral();

        require(
            collateralAmount * BPS_DENOMINATOR >= borrowed * MIN_HEALTH_FACTOR_BPS,
            "Insufficient collateral"
        );

        IShieldedPool(collateralShard).lockNullifier(noteNullifierHash);

        uint256 loanId = nextLoanId++;
        loans[loanId] = Loan({
            collateralNullifierHash: noteNullifierHash,
            borrowed: borrowed,
            timestamp: block.timestamp,
            recipient: recipient,
            collateralAmount: collateralAmount,
            liquidationThreshold: LIQUIDATION_THRESHOLD,
            repaid: false,
            collateralShard: collateralShard,
            disburseShard: disburseShard
        });
        activeLoanByNote[noteNullifierHash] = loanId;
        hasActiveLoan[noteNullifierHash] = true;
        totalBorrowed += borrowed;

        IShieldedPool(disburseShard).disburseLoan(recipient, borrowed);

        emit Borrowed(loanId);
    }

    // -- Core: Repay ----------------------------------------------------------
    function repay(uint256 loanId) external payable nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.borrowed == 0) revert LoanNotFound();
        if (loan.repaid) revert LoanAlreadyRepaid();

        uint256 interest = _calculateInterest(loan.borrowed, loan.timestamp);
        uint256 totalOwed = loan.borrowed + interest;

        if (msg.value < totalOwed) revert InsufficientRepayment();

        bytes32 collateralHash = loan.collateralNullifierHash;
        address collShard = loan.collateralShard;
        address disShard = loan.disburseShard;

        // Checks-Effects-Interactions: update all state before external calls
        loan.repaid = true;
        hasActiveLoan[collateralHash] = false;
        totalBorrowed -= loan.borrowed;

        // Refund overpayment — state already committed
        if (msg.value > totalOwed) {
            (bool ok, ) = msg.sender.call{value: msg.value - totalOwed}("");
            require(ok, "Refund failed");
        }

        // Unlock the collateral note so the borrower can withdraw it
        IShieldedPool(collShard).unlockNullifier(collateralHash);

        // Return ETH to the shard that originally disbursed it
        (bool fwd,) = payable(disShard).call{value: totalOwed}("");
        require(fwd, "Forward to shard failed");

        emit Repaid(loanId, totalOwed);
    }

    // -- Core: Settle collateral (called by ShieldedPool on locked withdraw) --
    function settleCollateral(bytes32 nullifierHash) external payable onlyShieldedPool nonReentrant {
        // Guard against mapping-default-value confusion: loan 0 is a real loan;
        // without this check, activeLoanByNote[unknownHash] == 0 would corrupt it.
        require(hasActiveLoan[nullifierHash], "No active loan for nullifier");

        uint256 loanId = activeLoanByNote[nullifierHash];
        Loan storage loan = loans[loanId];
        require(!loan.repaid, "Already repaid");

        // Only the shard that holds the collateral can settle it.
        // Prevents a different registered shard from settling a loan it doesn't own.
        require(msg.sender == loan.collateralShard, "Wrong shard for collateral");

        // Validate: caller must send enough ETH to cover the full debt
        uint256 totalOwed = loan.borrowed + _calculateInterest(loan.borrowed, loan.timestamp);
        require(msg.value >= totalOwed, "Insufficient settlement amount");

        address disShard = loan.disburseShard;

        // Checks-Effects-Interactions: update all state before external call
        loan.repaid = true;
        hasActiveLoan[nullifierHash] = false;
        totalBorrowed -= loan.borrowed;

        emit Repaid(loanId, msg.value);

        // Return ETH to the shard that originally disbursed the loan.
        // Without this, every auto-settle permanently drains ETH from the pool ecosystem.
        (bool fwd,) = payable(disShard).call{value: msg.value}("");
        require(fwd, "Forward to shard failed");
    }

    // -- Core: Liquidation ----------------------------------------------------
    function canLiquidate(uint256 loanId) public view returns (bool) {
        Loan storage l = loans[loanId];
        if (l.repaid || l.borrowed == 0) return false;
        uint256 totalOwed = l.borrowed + _calculateInterest(l.borrowed, l.timestamp);
        return (l.collateralAmount * LIQUIDATION_THRESHOLD) / 10000 < totalOwed;
    }

    function liquidate(uint256 loanId) external payable nonReentrant {
        require(canLiquidate(loanId), "Not liquidatable");
        Loan storage l = loans[loanId];
        uint256 totalOwed = getOwed(l.collateralNullifierHash);
        require(msg.value >= totalOwed, "Insufficient liquidation payment");

        bytes32 collateralHash = l.collateralNullifierHash;
        uint256 principal = l.borrowed;
        address collShard = l.collateralShard;
        address disShard = l.disburseShard;

        l.repaid = true;
        hasActiveLoan[collateralHash] = false;
        totalBorrowed -= principal;

        IShieldedPool(collShard).unlockNullifier(collateralHash);

        if (msg.value > totalOwed) {
            (bool ok,) = msg.sender.call{value: msg.value - totalOwed}("");
            require(ok, "Refund failed");
        }

        (bool fwd,) = payable(disShard).call{value: totalOwed}("");
        require(fwd, "Forward to shard failed");

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
    function getOwed(bytes32 nullifierHash) public view returns (uint256) {
        if (!hasActiveLoan[nullifierHash]) return 0;
        uint256 loanId = activeLoanByNote[nullifierHash];
        Loan storage loan = loans[loanId];
        if (loan.borrowed == 0 || loan.repaid) return 0;
        uint256 interest = _calculateInterest(loan.borrowed, loan.timestamp);
        return loan.borrowed + interest;
    }

    // -- Internal: Aave v3-style two-slope interest ---------------------------
    function _currentRate() internal view returns (uint256) {
        // Sum ETH balance across all registered shards for accurate utilization
        uint256 totalShardBalance = 0;
        for (uint256 i = 0; i < registeredShards.length; i++) {
            totalShardBalance += registeredShards[i].balance;
        }
        uint256 totalDeposited = totalShardBalance + totalBorrowed;
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
