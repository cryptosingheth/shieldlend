// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NullifierRegistry} from "./NullifierRegistry.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {IZkVerifyAggregation} from "./interfaces/IZkVerifyAggregation.sol";

/*
 * ShieldedPool — ShieldLend V2
 *
 * V2 changes vs V1:
 *   - LEVELS = 24 (depth-24 Merkle tree, 16M leaves — accommodates dummy commitments)
 *   - Fixed denominations: 0.1, 0.5, 1.0 ETH only
 *   - Epoch batching: commitments queue in pendingCommitments[], inserted via flushEpoch()
 *     every EPOCH_BLOCKS=50 blocks. Fisher-Yates shuffle with prevrandao before insertion.
 *   - Dummy commitments inserted each epoch (adaptive count) for metadata privacy
 *   - Protocol fee: 0.1% per deposit -> protocolFunds (used to tip flushEpoch callers)
 *   - Nullifier locking: LendingPool calls lockNullifier() to mark a note as collateral
 *   - Auto-settle: withdraw() automatically repays the active loan when collateral is locked
 *   - disburseLoan(): ETH disbursement for loans, only callable by LendingPool
 *   - ShieldedPool is the sole ETH vault; LendingPool is accounting-only
 */

interface ILendingPool {
    function getOwed(bytes32 nullifierHash) external view returns (uint256);
    function settleCollateral(bytes32 nullifierHash) external payable;
}

contract ShieldedPool {
    // -- Constants ------------------------------------------------------------
    uint32 public constant LEVELS = 24;    // 2^24 = ~16M possible deposits
    uint256 public constant FIELD_SIZE =   // BabyJubJub field prime (used by Poseidon in circomlib)
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // zkVerify proving system identifiers (Groth16 via circom/snarkjs on BN128)
    bytes32 public constant PROVING_SYSTEM_ID = keccak256(abi.encodePacked("groth16"));
    bytes32 public constant VERSION_HASH = sha256(abi.encodePacked(""));

    // Epoch constants
    uint256 public constant EPOCH_BLOCKS = 50;
    uint256 public constant DUMMIES_PER_EPOCH = 10;

    // Protocol fee: 0.1% (10 BPS)
    uint256 public constant PROTOCOL_FEE_BPS = 10;

    // -- State ----------------------------------------------------------------
    address public admin;
    address public lendingPool;

    NullifierRegistry public immutable nullifierRegistry;
    IZkVerifyAggregation public immutable zkVerifyAggregation;
    bytes32 public immutable vkHash; // keccak256 of the withdraw_ring circuit verification key

    // Incremental Merkle tree state
    bytes32[LEVELS] public filledSubTrees; // partial hashes at each tree level
    bytes32 public currentRoot;            // current Merkle root
    uint32 public nextIndex;               // index of the next empty leaf slot

    // Roots history: allows withdrawals during root transitions
    uint32 public constant ROOT_HISTORY_SIZE = 100;
    bytes32[ROOT_HISTORY_SIZE] public roots;
    uint32 public currentRootIndex;

    // Epoch batching
    bytes32[] public pendingCommitments;
    uint256 public lastEpochBlock;
    uint256 public epochNumber;

    // Nullifier locking (for collateral)
    mapping(bytes32 => bool) public lockedAsCollateral;

    // Protocol funds (fees + tips)
    uint256 public protocolFunds;

    // Cumulative dummy count (for _dummiesForEpoch — avoids underflow)
    uint256 public totalDummiesInserted;

    // ZEROS: Poseidon hashes of empty subtrees at each level
    bytes32[LEVELS] public ZEROS;

    // -- Events ---------------------------------------------------------------
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
    event EpochFlushed(uint256 indexed epochNumber, uint256 realCount, uint256 dummyCount);
    event LeafInserted(bytes32 indexed commitment, uint32 leafIndex);
    event NullifierLocked(bytes32 indexed nullifierHash);
    event LoanDisbursed(address indexed recipient, uint256 amount);

    // -- Errors ---------------------------------------------------------------
    error TreeFull();
    error InvalidProof();
    error NullifierAlreadySpent();
    error UnknownRoot();
    error InvalidDenomination();
    error InsufficientCollateralForSettlement();
    error EpochTooEarly();
    error NotAdmin();
    error NotLendingPool();

    // -- Modifiers ------------------------------------------------------------
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyLendingPool() {
        if (msg.sender != lendingPool) revert NotLendingPool();
        _;
    }

    // -- Initialization -------------------------------------------------------
    constructor(
        address _nullifierRegistry,
        address _zkVerifyAggregation,
        bytes32 _vkHash
    ) {
        admin = msg.sender;
        nullifierRegistry = NullifierRegistry(_nullifierRegistry);
        zkVerifyAggregation = IZkVerifyAggregation(_zkVerifyAggregation);
        vkHash = _vkHash;

        // Initialize ZEROS: zero leaf at level 0, then hash up
        bytes32 currentZero = bytes32(0);
        for (uint32 i = 0; i < LEVELS; i++) {
            ZEROS[i] = currentZero;
            filledSubTrees[i] = currentZero;
            currentZero = hashLeftRight(currentZero, currentZero);
        }

        currentRoot = currentZero;
        roots[0] = currentRoot;
        lastEpochBlock = block.number;
    }

    // -- Admin ----------------------------------------------------------------
    function setLendingPool(address _lp) external onlyAdmin {
        lendingPool = _lp;
    }

    // -- Core: Deposit --------------------------------------------------------
    /*
     * Queue a commitment for the next epoch flush.
     * Fixed denominations accepted: 0.001, 0.005, 0.01, 0.05, 0.1, 0.5 ETH.
     * 0.1% protocol fee withheld from each deposit.
     */
    function deposit(bytes32 commitment) external payable {
        if (
            msg.value != 0.001 ether &&
            msg.value != 0.005 ether &&
            msg.value != 0.01  ether &&
            msg.value != 0.05  ether &&
            msg.value != 0.1   ether &&
            msg.value != 0.5   ether
        ) revert InvalidDenomination();

        uint256 fee = (msg.value * PROTOCOL_FEE_BPS) / 10000;
        protocolFunds += fee;

        pendingCommitments.push(commitment);

        // Note: leafIndex in event is the QUEUE position, not the final tree index.
        // Actual tree index is emitted by LeafInserted during flushEpoch().
        emit Deposit(commitment, uint32(pendingCommitments.length - 1), block.timestamp, msg.value);
    }

    // -- Core: Epoch flush ----------------------------------------------------
    /*
     * Flush the pending commitments queue into the Merkle tree.
     * Callable by anyone after EPOCH_BLOCKS have passed since last flush.
     * Fisher-Yates shuffle with prevrandao seed before insertion decouples
     * deposit order from leaf index, breaking timing correlation.
     * Dummy commitments are appended after real ones for anonymity set inflation.
     * Caller receives 0.001 ETH tip from protocolFunds.
     */
    function flushEpoch() external {
        if (block.number < lastEpochBlock + EPOCH_BLOCKS) revert EpochTooEarly();

        uint256 realCount = pendingCommitments.length;
        uint256 dummyCount = _dummiesForEpoch();

        // Fisher-Yates shuffle using prevrandao as entropy source
        uint256 seed = block.prevrandao;
        bytes32[] memory shuffled = new bytes32[](realCount);
        for (uint256 i = 0; i < realCount; i++) {
            shuffled[i] = pendingCommitments[i];
        }
        for (uint256 i = realCount; i > 1; i--) {
            uint256 j = uint256(keccak256(abi.encodePacked(seed, i))) % i;
            bytes32 tmp = shuffled[i - 1];
            shuffled[i - 1] = shuffled[j];
            shuffled[j] = tmp;
        }

        // Insert shuffled real commitments
        for (uint256 i = 0; i < realCount; i++) {
            if (nextIndex >= 2 ** LEVELS) revert TreeFull();
            _insert(shuffled[i]);
        }

        // Insert dummy commitments (indistinguishable from real ones on-chain)
        uint256 actualDummies = 0;
        for (uint256 d = 0; d < dummyCount; d++) {
            if (nextIndex >= 2 ** LEVELS) break;
            bytes32 dummy = keccak256(abi.encodePacked(block.prevrandao, epochNumber, d));
            _insert(dummy);
            actualDummies++;
        }
        totalDummiesInserted += actualDummies;

        delete pendingCommitments;

        // Tip to incentivize keepers
        uint256 tip = 0.001 ether;
        if (protocolFunds >= tip) {
            protocolFunds -= tip;
            (bool ok,) = msg.sender.call{value: tip}("");
            require(ok, "Tip transfer failed");
        }

        emit EpochFlushed(epochNumber, realCount, dummyCount);

        lastEpochBlock = block.number;
        epochNumber++;
    }

    // -- Core: Withdraw -------------------------------------------------------
    /*
     * Process a withdrawal backed by a zkVerify aggregation proof.
     * If the nullifier is locked as collateral, auto-settles the loan first:
     *   - deducts totalOwed from the withdrawal amount
     *   - sends remainder to recipient
     *   - loan is atomically closed in a single tx
     */
    function withdraw(
        bytes32 root,
        bytes32 nullifierHash,
        address payable recipient,
        uint256 amount,
        uint256 domainId,
        uint256 aggregationId,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) external {
        // ── PROOF VERIFICATION (runs for ALL withdrawals, including auto-settle) ──
        // Without this gate, anyone who observes a NullifierLocked event could call
        // withdraw() with the locked nullifier and drain the pool.
        if (!isKnownRoot(root)) revert UnknownRoot();
        if (nullifierRegistry.isSpent(nullifierHash)) revert NullifierAlreadySpent();

        if (
            !_verifyAttestation(
                root, nullifierHash, recipient, amount,
                domainId, aggregationId, merklePath, leafCount, leafIndex
            )
        ) {
            revert InvalidProof();
        }

        nullifierRegistry.markSpent(nullifierHash);

        // ── AUTO-SETTLE PATH: locked note → repay loan atomically ────────────
        if (lockedAsCollateral[nullifierHash]) {
            uint256 totalOwed = ILendingPool(lendingPool).getOwed(nullifierHash);
            if (amount < totalOwed) revert InsufficientCollateralForSettlement();
            lockedAsCollateral[nullifierHash] = false; // release lock
            ILendingPool(lendingPool).settleCollateral{value: totalOwed}(nullifierHash);
            uint256 remainder = amount - totalOwed;
            if (remainder > 0) {
                (bool ok,) = recipient.call{value: remainder}("");
                require(ok, "Transfer failed");
            }
            emit Withdrawal(recipient, nullifierHash, remainder);
            return;
        }

        // ── NORMAL WITHDRAWAL ────────────────────────────────────────────────
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawal(recipient, nullifierHash, amount);
    }

    // -- LendingPool interface -------------------------------------------------

    /// @notice Lock a nullifier as active collateral. Only callable by LendingPool.
    function lockNullifier(bytes32 nullifierHash) external onlyLendingPool {
        lockedAsCollateral[nullifierHash] = true;
        emit NullifierLocked(nullifierHash);
    }

    /// @notice Disburse ETH for a loan. Only callable by LendingPool.
    function disburseLoan(address payable recipient, uint256 amount) external onlyLendingPool {
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "Disbursement failed");
        emit LoanDisbursed(recipient, amount);
    }

    // -- View: Root history ---------------------------------------------------
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

    // -- View: Statement hash -------------------------------------------------

    /// @notice Compute the zkVerify statement hash for a set of public inputs.
    ///         Off-chain callers use this to build the aggregation leaf.
    function statementHash(uint256[] memory inputs) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                PROVING_SYSTEM_ID,
                vkHash,
                VERSION_HASH,
                keccak256(_encodePublicInputs(inputs))
            )
        );
    }

    // -- Internal: Dummy count ------------------------------------------------
    function _dummiesForEpoch() internal view returns (uint256) {
        // totalDummiesInserted tracks actual dummies (not a constant multiple).
        // Without this, nextIndex - epochNumber*DUMMIES_PER_EPOCH underflows
        // once adaptive logic reduces dummy count below DUMMIES_PER_EPOCH.
        uint256 realCount = nextIndex > totalDummiesInserted ? nextIndex - uint256(totalDummiesInserted) : 0;
        if (realCount < 200) return 10;
        if (realCount < 1000) return 5;
        return 2;
    }

    // -- Internal: Incremental Merkle tree ------------------------------------
    function _insert(bytes32 leaf) internal returns (uint32 index) {
        uint32 currentIndex = nextIndex;
        bytes32 currentLevelHash = leaf;
        bytes32 left;
        bytes32 right;

        for (uint32 i = 0; i < LEVELS; i++) {
            if (currentIndex % 2 == 0) {
                left = currentLevelHash;
                right = ZEROS[i];
                filledSubTrees[i] = currentLevelHash;
            } else {
                left = filledSubTrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hashLeftRight(left, right);
            currentIndex /= 2;
        }

        currentRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        roots[currentRootIndex] = currentLevelHash;
        currentRoot = currentLevelHash;
        uint32 insertedAt = nextIndex;
        nextIndex++;
        emit LeafInserted(leaf, insertedAt);
        return insertedAt;
    }

    /// @dev Poseidon(left, right) -- matches withdraw_ring.circom MerkleTreeChecker.
    function hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return bytes32(PoseidonT3.hash([uint256(left), uint256(right)]));
    }

    // -- Internal: zkVerify attestation check ---------------------------------
    function _verifyAttestation(
        bytes32 root,
        bytes32 nullifierHash,
        address recipient,
        uint256 amount,
        uint256 domainId,
        uint256 aggregationId,
        bytes32[] calldata merklePath,
        uint256 leafCount,
        uint256 leafIndex
    ) internal view returns (bool) {
        uint256[] memory inputs = new uint256[](4);
        inputs[0] = uint256(root);
        inputs[1] = uint256(nullifierHash);
        inputs[2] = uint256(uint160(recipient));
        inputs[3] = amount;

        bytes32 leaf = statementHash(inputs);

        return zkVerifyAggregation.verifyProofAggregation(
            domainId, aggregationId, leaf, merklePath, leafCount, leafIndex
        );
    }

    // -- Internal: Groth16 public-input encoding ------------------------------

    /// @dev Encode public inputs in the byte order used by zkVerify's Groth16 pallet.
    ///      Each field element is byte-reversed (EVM big-endian to Substrate little-endian).
    function _encodePublicInputs(uint256[] memory inputs) internal pure returns (bytes memory) {
        uint256 n = inputs.length;
        bytes32[] memory encoded = new bytes32[](n);
        for (uint256 i; i < n;) {
            encoded[i] = _changeEndianness(inputs[i]);
            unchecked { ++i; }
        }
        return abi.encodePacked(encoded);
    }

    /// @dev Reverse byte order of a 256-bit word (big-endian to little-endian).
    function _changeEndianness(uint256 input) internal pure returns (bytes32 v) {
        v = bytes32(input);
        v = ((v & 0xff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00) >> 8)
          | ((v & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff) << 8);
        v = ((v & 0xffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000) >> 16)
          | ((v & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff) << 16);
        v = ((v & 0xffffffff00000000ffffffff00000000ffffffff00000000ffffffff00000000) >> 32)
          | ((v & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff) << 32);
        v = ((v & 0xffffffffffffffff0000000000000000ffffffffffffffff0000000000000000) >> 64)
          | ((v & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff) << 64);
        v = (v >> 128) | (v << 128);
    }

    // -- Receive ETH ----------------------------------------------------------
    receive() external payable {}
}
