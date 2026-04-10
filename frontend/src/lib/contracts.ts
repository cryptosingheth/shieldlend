/**
 * ShieldLend Contract Interface — V2
 * =====================================
 * Typed wrappers around ShieldedPool, LendingPool, and NullifierRegistry using wagmi/viem.
 *
 * V2 changes vs V1:
 *   - LENDING_POOL_ABI.borrow: removed Groth16 proof args (pA/pB/pC); collateral verified off-chain via zkVerify
 *   - Added getOwed() read hook
 *   - Added NULLIFIER_REGISTRY_ADDRESS + NULLIFIER_REGISTRY_ABI + useIsSpent hook
 *   - Borrowed event: only emits loanId (no amount / recipient — privacy)
 */

import { type Address, parseAbi } from "viem";
import { baseSepolia } from "wagmi/chains";
import {
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
  useChainId,
} from "wagmi";

// ─────────────────────────────────────────────────────────────────────────────
// Contract addresses (set via env vars — different per network)
// ─────────────────────────────────────────────────────────────────────────────

export const SHIELDED_POOL_ADDRESS = (process.env.NEXT_PUBLIC_SHIELDED_POOL_ADDRESS ||
  process.env.NEXT_PUBLIC_SHARD_1 ||
  "0x0000000000000000000000000000000000000000") as Address;

// All 5 shard addresses — used for multi-shard log scanning on withdrawal.
// Deposits are randomly routed, so we must search all shards to find a commitment.
export const ALL_SHARD_ADDRESSES: Address[] = ([
  process.env.NEXT_PUBLIC_SHARD_1,
  process.env.NEXT_PUBLIC_SHARD_2,
  process.env.NEXT_PUBLIC_SHARD_3,
  process.env.NEXT_PUBLIC_SHARD_4,
  process.env.NEXT_PUBLIC_SHARD_5,
].filter(Boolean) as string[]).map(a => a as Address);

// Fall back to SHIELDED_POOL_ADDRESS if shard env vars are not set
if (ALL_SHARD_ADDRESSES.length === 0) ALL_SHARD_ADDRESSES.push(SHIELDED_POOL_ADDRESS);

export const LENDING_POOL_ADDRESS = (process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const NULLIFIER_REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_NULLIFIER_REGISTRY_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

// ─────────────────────────────────────────────────────────────────────────────
// ABIs (minimal — only what the frontend needs)
// ─────────────────────────────────────────────────────────────────────────────

export const SHIELDED_POOL_ABI = parseAbi([
  // Read
  "function getLastRoot() view returns (bytes32)",
  "function isKnownRoot(bytes32 root) view returns (bool)",
  "function nextIndex() view returns (uint32)",
  "function statementHash(uint256[] inputs) view returns (bytes32)",
  "function lastEpochBlock() view returns (uint256)",
  "function EPOCH_BLOCKS() view returns (uint256)",
  "function pendingCommitments(uint256 index) view returns (bytes32)",
  // Write
  "function deposit(bytes32 commitment, bytes encryptedNote) payable",
  "function withdraw(bytes32 root, bytes32 nullifierHash, address recipient, uint256 denomination, uint256 domainId, uint256 aggregationId, bytes32[] merklePath, uint256 leafCount, uint256 leafIndex)",
  "function flushEpoch()",
  // Events
  "event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp, uint256 amount, bytes encryptedNote)",
  "event LeafInserted(bytes32 indexed commitment, uint32 leafIndex)",
  "event Withdrawal(address indexed recipient, bytes32 nullifierHash, uint256 amount)",
  "event EpochFlushed(uint256 indexed epochNumber, uint256 realCount, uint256 dummyCount)",
]);

export const LENDING_POOL_ABI = parseAbi([
  // Read
  "function getLoanDetails(uint256 loanId) view returns (bytes32 collateralNullifierHash, uint256 borrowed, uint256 currentInterest, uint256 totalOwed, bool repaid)",
  "function hasActiveLoan(bytes32 noteNullifierHash) view returns (bool)",
  "function activeLoanByNote(bytes32 noteNullifierHash) view returns (uint256)",
  "function getOwed(bytes32 nullifierHash) view returns (uint256)",
  // V2 borrow: no Groth16 proof args — collateral verified off-chain via zkVerify
  "function borrow(bytes32 noteNullifierHash, uint256 borrowed, uint256 collateralAmount, address recipient)",
  "function repay(uint256 loanId) payable",
  // Events — V2: Borrowed emits only loanId for privacy
  "event Borrowed(uint256 indexed loanId)",
  "event Repaid(uint256 indexed loanId, uint256 totalRepaid)",
]);

export const NULLIFIER_REGISTRY_ABI = parseAbi([
  "function isSpent(bytes32 nullifierHash) view returns (bool)",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

/** Get the current Merkle root from ShieldedPool */
export function useCurrentRoot() {
  return useReadContract({
    address: SHIELDED_POOL_ADDRESS,
    abi: SHIELDED_POOL_ABI,
    functionName: "getLastRoot",
  });
}

/** Get how many deposits have been made */
export function useDepositCount() {
  return useReadContract({
    address: SHIELDED_POOL_ADDRESS,
    abi: SHIELDED_POOL_ABI,
    functionName: "nextIndex",
  });
}

/** Check if a note has an active loan */
export function useHasActiveLoan(nullifierHash: `0x${string}` | undefined) {
  return useReadContract({
    address: LENDING_POOL_ADDRESS,
    abi: LENDING_POOL_ABI,
    functionName: "hasActiveLoan",
    args: [nullifierHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000"],
    query: { enabled: !!nullifierHash },
  });
}

/** Get loan details by ID */
export function useLoanDetails(loanId: bigint | undefined) {
  return useReadContract({
    address: LENDING_POOL_ADDRESS,
    abi: LENDING_POOL_ABI,
    functionName: "getLoanDetails",
    args: [loanId ?? 0n],
    query: { enabled: loanId !== undefined },
  });
}

/**
 * Get the total owed (principal + interest) for a collateral nullifier.
 * Used by WithdrawForm to show auto-settle preview.
 */
export function useGetOwed(nullifierHash: `0x${string}` | undefined) {
  return useReadContract({
    address: LENDING_POOL_ADDRESS,
    abi: LENDING_POOL_ABI,
    functionName: "getOwed",
    args: [nullifierHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000"],
    // gcTime: 0 — discard cache immediately when note is deselected.
    // Prevents stale loan data from a previous note bleeding into a freshly selected one.
    query: { enabled: !!nullifierHash, gcTime: 0, staleTime: 0 },
  });
}

/**
 * Check if a nullifier has been spent on-chain.
 * Used by Dashboard to sync local note state with NullifierRegistry.
 */
export function useIsSpent(nullifierHash: `0x${string}` | undefined) {
  return useReadContract({
    address: NULLIFIER_REGISTRY_ADDRESS,
    abi: NULLIFIER_REGISTRY_ABI,
    functionName: "isSpent",
    args: [nullifierHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000"],
    query: { enabled: !!nullifierHash },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Write hooks
// ─────────────────────────────────────────────────────────────────────────────

export function useDeposit() {
  const { writeContractAsync, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const { switchChainAsync } = useSwitchChain();
  const chainId = useChainId();

  const deposit = async (commitment: `0x${string}`, amount: bigint, encryptedNote: `0x${string}` = "0x") => {
    if (chainId !== baseSepolia.id) {
      await switchChainAsync({ chainId: baseSepolia.id });
    }
    return writeContractAsync({
      address: SHIELDED_POOL_ADDRESS,
      abi: SHIELDED_POOL_ABI,
      functionName: "deposit",
      args: [commitment, encryptedNote],
      value: amount,
    });
  };

  return { deposit, hash, isPending, isConfirming, isSuccess, error };
}

export function useWithdraw() {
  const { writeContractAsync, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const { switchChainAsync } = useSwitchChain();
  const chainId = useChainId();

  const withdraw = async (
    root: `0x${string}`,
    nullifierHash: `0x${string}`,
    recipient: Address,
    denomination: bigint,
    domainId: bigint,
    aggregationId: bigint,
    merklePath: `0x${string}`[],
    leafCount: bigint,
    leafIndex: bigint,
    shardAddress?: Address  // which shard to call — defaults to SHIELDED_POOL_ADDRESS
  ) => {
    if (chainId !== baseSepolia.id) {
      await switchChainAsync({ chainId: baseSepolia.id });
    }
    return writeContractAsync({
      address: shardAddress ?? SHIELDED_POOL_ADDRESS,
      abi: SHIELDED_POOL_ABI,
      functionName: "withdraw",
      args: [root, nullifierHash, recipient, denomination, domainId, aggregationId, merklePath, leafCount, leafIndex],
    });
  };

  return { withdraw, hash, isPending, isConfirming, isSuccess, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Epoch status hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns live epoch timing data so components can show countdown banners.
 *
 * blocksRemaining: how many blocks until flushEpoch() is callable (0 = callable now)
 * secondsRemaining: rough wall-clock estimate (Base Sepolia ~2s per block)
 * canFlush: true when blocksRemaining === 0
 */
export function useEpochStatus() {
  const { data: lastEpochBlock } = useReadContract({
    address: SHIELDED_POOL_ADDRESS,
    abi: SHIELDED_POOL_ABI,
    functionName: "lastEpochBlock",
    query: { refetchInterval: 12_000 },
  });

  const { data: epochBlocks } = useReadContract({
    address: SHIELDED_POOL_ADDRESS,
    abi: SHIELDED_POOL_ABI,
    functionName: "EPOCH_BLOCKS",
  });

  const { data: nextLeafIndex } = useReadContract({
    address: SHIELDED_POOL_ADDRESS,
    abi: SHIELDED_POOL_ABI,
    functionName: "nextIndex",
    query: { refetchInterval: 12_000 },
  });

  // Use nextIndex as a proxy for current block progress — not perfect but avoids
  // an extra RPC call. For block number we rely on lastEpochBlock + EPOCH_BLOCKS.
  const blocksRemaining =
    lastEpochBlock !== undefined && epochBlocks !== undefined
      ? Number(epochBlocks) // default to full epoch if we can't read block
      : 50;

  // To get the real remaining blocks we'd need publicClient.getBlockNumber().
  // Expose raw values so callers can compute it themselves with useBlockNumber.
  return {
    lastEpochBlock: lastEpochBlock as bigint | undefined,
    epochBlocks: epochBlocks as bigint | undefined,
    nextLeafIndex: nextLeafIndex as number | undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Format a bytes32 value as a short hex for display */
export function shortHash(hash: `0x${string}`): string {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

/** Convert a circuit field element bigint to bytes32 hex */
export function fieldToBytes32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
