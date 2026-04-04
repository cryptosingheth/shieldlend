import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import {
  createWalletClient,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Server-side borrow flow (V2):
//  1. Accept { proof, publicSignals, noteNullifierHash, borrowed, collateralAmount, recipient }
//  2. Submit collateral_ring Groth16 proof to zkVerify Volta → verified off-chain
//  3. Call LendingPool.borrow(noteNullifierHash, borrowed, collateralAmount, recipient)
//     — No on-chain Groth16 verifier in V2. ZK proof is verified by zkVerify before this call.
//  4. Return { txHash, aggregationId }
//
// V2 vs V1 changes:
//   - Removed pA/pB/pC extraction (no on-chain verifier)
//   - Changed vkey: collateral_vkey.json → collateral_ring_vkey.json
//   - borrow() ABI: 4 args only (noteNullifierHash, borrowed, collateralAmount, recipient)
//   - No aggregation root posting (LendingPool does not call _verifyAttestation)

const DOMAIN_ID = 0;

// V2 LendingPool.borrow — no proof args
const LENDING_POOL_ABI = parseAbi([
  "function borrow(bytes32 noteNullifierHash, uint256 borrowed, uint256 collateralAmount, address recipient) external",
]);

export async function POST(req: NextRequest) {
  try {
    const { proof, publicSignals, noteNullifierHash, borrowed, collateralAmount, recipient } =
      await req.json();

    if (!proof || !publicSignals || !noteNullifierHash || !borrowed || !collateralAmount || !recipient) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const SEED_PHRASE = process.env.ZKVERIFY_SEED_PHRASE;
    if (!SEED_PHRASE) {
      return NextResponse.json({ error: "ZKVERIFY_SEED_PHRASE not set" }, { status: 500 });
    }

    const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
    const LENDING_POOL_ADDRESS = process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS as
      | `0x${string}`
      | undefined;

    if (!DEPLOYER_KEY || !LENDING_POOL_ADDRESS) {
      return NextResponse.json(
        { error: "DEPLOYER_PRIVATE_KEY or NEXT_PUBLIC_LENDING_POOL_ADDRESS not set" },
        { status: 500 }
      );
    }

    const { zkVerifySession, ZkVerifyEvents, Library, CurveType } = await import("zkverifyjs");

    const keysDir = path.join(process.cwd(), "..", "circuits", "keys");
    // V2: collateral circuit is collateral_ring
    const vkey = JSON.parse(
      fs.readFileSync(path.join(keysDir, "collateral_ring_vkey.json"), "utf8")
    );

    const session = await zkVerifySession.start().Volta().withAccount(SEED_PHRASE);

    try {
      const { events, transactionResult } = await session
        .verify()
        .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
        .execute({ proofData: { vk: vkey, proof, publicSignals }, domainId: DOMAIN_ID });

      let aggregationId: number = 0;

      events.on(ZkVerifyEvents.IncludedInBlock, (eventData: { aggregationId: number }) => {
        if (eventData.aggregationId) aggregationId = eventData.aggregationId;
      });

      const result = await transactionResult;

      // zkVerify confirmed — now call LendingPool.borrow() directly (no on-chain verifier)
      const account = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http("https://sepolia.base.org"),
      });

      const txHash = await walletClient.writeContract({
        account,
        address: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: "borrow",
        args: [
          noteNullifierHash as `0x${string}`,
          BigInt(borrowed),
          BigInt(collateralAmount),
          recipient as `0x${string}`,
        ],
      });

      return NextResponse.json({ txHash, aggregationId, zkTxHash: result.txHash });
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error("[borrow route]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
