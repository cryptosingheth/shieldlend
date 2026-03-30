import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Server-side borrow flow:
//  1. Accept { proof, publicSignals, noteNullifierHash, borrowed, recipient, zkVerifyAttestationId }
//  2. Submit collateral Groth16 proof to zkVerify Volta → verified on their chain
//  3. Extract pA/pB/pC calldata (Solidity-formatted curve points)
//  4. Call LendingPool.borrow() with proof + params
//  5. Return { txHash, aggregationId }

const DOMAIN_ID = 0;

const LENDING_POOL_ABI = parseAbi([
  "function borrow(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes32 noteNullifierHash, uint256 borrowed, address recipient, uint256 zkVerifyAttestationId) payable",
]);

export async function POST(req: NextRequest) {
  try {
    const { proof, publicSignals, noteNullifierHash, borrowed, recipient, zkVerifyAttestationId } =
      await req.json();

    if (!proof || !publicSignals || !noteNullifierHash || !borrowed || !recipient) {
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
    const vkey = JSON.parse(
      fs.readFileSync(path.join(keysDir, "collateral_vkey.json"), "utf8")
    );

    const session = await zkVerifySession.start().Volta().withAccount(SEED_PHRASE);

    try {
      const { events, transactionResult } = await session
        .verify()
        .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
        .execute({ proofData: { vk: vkey, proof, publicSignals }, domainId: DOMAIN_ID });

      let aggregationId: number = zkVerifyAttestationId ?? Math.floor(Date.now() / 1000);

      events.on(ZkVerifyEvents.IncludedInBlock, (eventData: { aggregationId: number }) => {
        if (eventData.aggregationId) aggregationId = eventData.aggregationId;
      });

      await transactionResult;

      // Extract Groth16 calldata (pA, pB, pC) for on-chain verification
      // snarkjs types don't expose exportSolidityCallData — cast to any
      const snarkjs = await import("snarkjs");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calldataRaw = await (snarkjs.groth16 as any).exportSolidityCallData(proof, publicSignals);
      // exportSolidityCallData returns: [pA_hex, pB_hex, pC_hex, pubInputs_hex]
      const calldata = JSON.parse("[" + calldataRaw + "]") as [
        [string, string],
        [[string, string], [string, string]],
        [string, string],
        string[]
      ];

      const pA = calldata[0].map((x) => BigInt(x)) as [bigint, bigint];
      const pB = calldata[1].map((pair) => pair.map((x) => BigInt(x))) as [
        [bigint, bigint],
        [bigint, bigint]
      ];
      const pC = calldata[2].map((x) => BigInt(x)) as [bigint, bigint];

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
          pA,
          pB,
          pC,
          noteNullifierHash as `0x${string}`,
          BigInt(borrowed),
          recipient as `0x${string}`,
          BigInt(aggregationId),
        ],
      });

      return NextResponse.json({ txHash, aggregationId });
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
