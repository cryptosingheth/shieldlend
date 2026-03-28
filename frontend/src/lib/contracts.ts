/**
 * ShieldLend Contract Interface
 * ==============================
 * Typed wrappers around ShieldedPool and LendingPool contract calls using wagmi/viem.
 */

import { type Address, parseAbi, formatEther } from "viem";
import {
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";

// ─────────────────────────────────────────────────────────────────────────────
// Contract addresses (set via env vars — different per network)
// ─────────────────────────────────────────────────────────────────────────────

export const SHIELDED_POOL_ADDRESS = (process.env.NEXT_PUBLIC_SHIELDED_POOL_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

export const LENDING_POOL_ADDRESS = (process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

// ─────────────────────────────────────────────────────────────────────────────
// ABIs (minimal — only what the frontend needs)
// ─────────────────────────────────────────────────────────────────────────────

export const SHIELDED_POOL_ABI = parseAbi([
  // Read
  "function getLastRoot() view returns (bytes32)",
  "function isKnownRoot(bytes32 root) view returns (bool)",
  "function nextIndex() view returns (uint32)",
  // Write
  "function deposit(bytes32 commitment) payable",
  "function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 amount, uint256 attestationId)",
  // Events
  "event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp, uint256 amount)",
  "event Withdrawal(address indexed recipient, bytes32 nullifierHash, uint256 amount)",
]);

export const LENDING_POOL_ABI = parseAbi([
  // Read
  "function getLoanDetails(uint256 loanId) view returns (bytes32 collateralNullifierHash, uint256 borrowed, uint256 currentInterest, uint256 totalOwed, bool repaid)",
  "function hasActiveLoan(bytes32 noteNullifierHash) view returns (bool)",
  "function activeLoanByNote(bytes32 noteNullifierHash) view returns (uint256)",
  // Write
  "function borrow(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes32 noteNullifierHash, uint256 borrowed, address recipient, uint256 zkVerifyAttestationId) payable",
  "function repay(uint256 loanId) payable",
  // Events
  "event Borrowed(uint256 indexed loanId, bytes32 indexed collateralNullifierHash, uint256 amount, address recipient)",
  "event Repaid(uint256 indexed loanId, uint256 totalRepaid)",
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

// ─────────────────────────────────────────────────────────────────────────────
// Write hooks
// ─────────────────────────────────────────────────────────────────────────────

export function useDeposit() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const deposit = (commitment: `0x${string}`, amount: bigint) => {
    writeContract({
      address: SHIELDED_POOL_ADDRESS,
      abi: SHIELDED_POOL_ABI,
      functionName: "deposit",
      args: [commitment],
      value: amount,
    });
  };

  return { deposit, hash, isPending, isConfirming, isSuccess, error };
}

export function useWithdraw() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const withdraw = (
    proof: `0x${string}`,
    root: `0x${string}`,
    nullifierHash: `0x${string}`,
    recipient: Address,
    amount: bigint,
    attestationId: bigint
  ) => {
    writeContract({
      address: SHIELDED_POOL_ADDRESS,
      abi: SHIELDED_POOL_ABI,
      functionName: "withdraw",
      args: [proof, root, nullifierHash, recipient, amount, attestationId],
    });
  };

  return { withdraw, hash, isPending, isConfirming, isSuccess, error };
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
