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
 * Returns: { txHash: "0x..." }
 *
 * encryptedNote: Feature D — AES-256-GCM ciphertext of note data encrypted with the
 * user's viewing key. Stored in the Deposit event log for note recovery. Pass undefined
 * or "0x" if the viewing key is not loaded.
 *
 * The server wallet must hold ETH (pre-funded from faucet on testnet).
 * User computes the commitment client-side — secret/nullifier never leave the browser.
 */

import { NextRequest, NextResponse } from "next/server";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const POOL_ABI = parseAbi([
  "function deposit(bytes32 commitment, bytes encryptedNote) external payable",
]);

export async function POST(req: NextRequest) {
  try {
    const { commitment, denomination, encryptedNote } = await req.json();

    if (!commitment || !denomination) {
      return NextResponse.json({ error: "Missing commitment or denomination" }, { status: 400 });
    }

    const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
    const poolAddress = process.env.NEXT_PUBLIC_SHIELDED_POOL_ADDRESS;

    if (!deployerKey || !poolAddress) {
      return NextResponse.json({ error: "Server misconfigured — missing env vars" }, { status: 500 });
    }

    const account = privateKeyToAccount(deployerKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    });

    // encryptedNote defaults to "0x" (empty bytes) if viewing key not loaded
    const noteBytes = (encryptedNote ?? "0x") as `0x${string}`;

    const txHash = await walletClient.writeContract({
      address: poolAddress as `0x${string}`,
      abi: POOL_ABI,
      functionName: "deposit",
      args: [commitment as `0x${string}`, noteBytes],
      value: BigInt(denomination),
    });

    return NextResponse.json({ txHash });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/deposit]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
