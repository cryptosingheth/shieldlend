/**
 * POST /api/deposit — Server-side deposit relay (Feature B)
 * ==========================================================
 * Submits the deposit transaction on behalf of the user using the server's
 * deployer wallet. The user's wallet address never appears in the deposit tx.
 *
 * ShieldedPool.deposit() has no access control and does not reference msg.sender.
 * The Deposit event emits: commitment, leafIndex, timestamp, amount — no sender.
 *
 * Body: { commitment: "0x...", denomination: "100000000000000", encryptedNote?: "0x..." }
 * Returns: { txHash: "0x...", shardAddress: "0x..." }
 *
 * encryptedNote: Feature D — AES-256-GCM ciphertext of note data encrypted with the
 * user's viewing key. Stored in the Deposit event log for note recovery. Pass undefined
 * or "0x" if the viewing key is not loaded.
 *
 * The server wallet must hold ETH (pre-funded from faucet on testnet).
 * User computes the commitment client-side — secret/nullifier never leave the browser.
 *
 * Reliability:
 *   - Explicit gas limit bypasses eth_estimateGas simulation (prevents false revert errors
 *     before the tx is even submitted, which left ETH stranded in the relay).
 *   - Waits for on-chain confirmation and checks receipt.status before returning 200.
 *     If the tx reverts on-chain, returns 500 so the client keeps the note visible.
 *   - Retries submission up to 3 times for transient RPC errors (nonce is re-fetched
 *     each attempt so duplicate submissions don't occur).
 */

import { NextRequest, NextResponse } from "next/server";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const POOL_ABI = parseAbi([
  "function deposit(bytes32 commitment, bytes encryptedNote) external payable",
]);

// Well above the actual gas cost (~80k) for ShieldedPool.deposit().
// Explicit limit bypasses eth_estimateGas — the main source of spurious reverts
// that left user ETH stranded in the relay.
const DEPOSIT_GAS_LIMIT = 300_000n;

const BASE_SEPOLIA_RPC = "https://sepolia.base.org";

export async function POST(req: NextRequest) {
  try {
    const { commitment, denomination, encryptedNote } = await req.json();

    if (!commitment || !denomination) {
      return NextResponse.json({ error: "Missing commitment or denomination" }, { status: 400 });
    }

    const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

    // Feature E: randomly select one of the 5 deployed shards per deposit.
    // An on-chain observer sees the relay send to a random shard address —
    // they cannot know which shard holds a given user's commitment without
    // scanning all 5 shards' event logs.
    const shards = [
      process.env.NEXT_PUBLIC_SHARD_1,
      process.env.NEXT_PUBLIC_SHARD_2,
      process.env.NEXT_PUBLIC_SHARD_3,
      process.env.NEXT_PUBLIC_SHARD_4,
      process.env.NEXT_PUBLIC_SHARD_5,
    ].filter(Boolean) as string[];

    const poolAddress = shards.length > 0
      ? shards[Math.floor(Math.random() * shards.length)]
      : process.env.NEXT_PUBLIC_SHIELDED_POOL_ADDRESS;

    if (!deployerKey || !poolAddress) {
      return NextResponse.json({ error: "Server misconfigured — missing env vars" }, { status: 500 });
    }

    const account = privateKeyToAccount(deployerKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(BASE_SEPOLIA_RPC),
    });
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(BASE_SEPOLIA_RPC),
    });

    const noteBytes = (encryptedNote ?? "0x") as `0x${string}`;
    const value = BigInt(denomination);

    // Retry submission for transient RPC errors. Each attempt re-fetches the nonce
    // so there is no risk of submitting duplicate transactions.
    let txHash: `0x${string}` | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        txHash = await walletClient.writeContract({
          address: poolAddress as `0x${string}`,
          abi: POOL_ABI,
          functionName: "deposit",
          args: [commitment as `0x${string}`, noteBytes],
          value,
          gas: DEPOSIT_GAS_LIMIT,
        });
        break;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : "";
        // Don't retry logic errors — only transient network/timeout issues.
        if (msg.includes("InvalidDenomination") || msg.includes("Note too large")) throw err;
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }

    if (!txHash) throw lastError;

    // Wait for on-chain confirmation and verify the tx succeeded.
    // Without this check, a reverted deposit would look like success to the client,
    // saving a note for a commitment that never landed in the shard's pending queue.
    // 90s timeout: Base Sepolia mines every ~2s so this covers transient congestion
    // without blocking the handler indefinitely.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    if (receipt.status !== "success") {
      console.error("[/api/deposit] tx reverted", txHash);
      return NextResponse.json(
        { error: "Deposit reverted on-chain — denomination or commitment rejected by shard", txHash },
        { status: 500 }
      );
    }

    return NextResponse.json({ txHash, shardAddress: poolAddress });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/deposit]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
