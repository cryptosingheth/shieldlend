import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodePacked,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Server-side zkVerify submission — keeps seed phrase off the browser
//
// Flow (post-dev-merge):
//  1. Submit Groth16 proof to zkVerify Volta → verified on their chain
//  2. Compute statement leaf = ShieldedPool.statementHash(publicSignals)
//  3. Build single-leaf aggregation root = keccak256(leaf)
//  4. Post root to our ZkVerifyAggregation contract (deployer is operator)
//  5. Return { aggregationId, domainId, merklePath, leafCount, leafIndex, txHash }
//
// The frontend uses aggregationId + merklePath to call ShieldedPool.withdraw()
// which verifies Merkle inclusion on-chain.

const DOMAIN_ID = 0;

// Minimal ABI for the two contracts we interact with
const SHIELDED_POOL_ABI = parseAbi([
  "function statementHash(uint256[] memory inputs) external view returns (bytes32)",
]);

const ZK_AGG_ABI = parseAbi([
  "function submitAggregation(uint256 domainId, uint256 aggregationId, bytes32 root) external",
]);

export async function POST(req: NextRequest) {
  try {
    const { circuit, proof, publicSignals } = await req.json();

    if (!["deposit", "withdraw", "collateral"].includes(circuit)) {
      return NextResponse.json({ error: "Invalid circuit" }, { status: 400 });
    }

    const SEED_PHRASE = process.env.ZKVERIFY_SEED_PHRASE;
    if (!SEED_PHRASE) {
      return NextResponse.json({ error: "ZKVERIFY_SEED_PHRASE not set" }, { status: 500 });
    }

    const { zkVerifySession, ZkVerifyEvents, Library, CurveType } = await import("zkverifyjs");

    const keysDir = path.join(process.cwd(), "..", "circuits", "keys");
    const vkey = JSON.parse(fs.readFileSync(path.join(keysDir, `${circuit}_vkey.json`), "utf8"));

    const session = await zkVerifySession.start().Volta().withAccount(SEED_PHRASE);

    try {
      const { events, transactionResult } = await session
        .verify()
        .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
        .execute({ proofData: { vk: vkey, proof, publicSignals }, domainId: DOMAIN_ID });

      let statement: string | null = null;
      let aggregationId: number = 0;

      events.on(ZkVerifyEvents.IncludedInBlock, (eventData: {
        blockHash: string;
        statement: string;
        aggregationId: number;
      }) => {
        statement = eventData.statement;
        aggregationId = eventData.aggregationId ?? 0;
      });

      // Wait for proof verification on Volta (not aggregation — that takes minutes)
      const result = await transactionResult;

      // ── Post aggregation root to our ZkVerifyAggregation contract ────────────
      // This makes the on-chain verification path work without waiting for the
      // real Volta aggregation relayer (which may take 5+ minutes on testnet).
      //
      // We compute the same leaf that ShieldedPool._verifyAttestation() will check:
      //   leaf = ShieldedPool.statementHash(publicSignals)
      // Then wrap it in a single-leaf tree and post as an aggregation root.

      const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
      const ZK_AGG_ADDRESS = process.env.ZKVERIFY_AGGREGATION_ADDRESS as `0x${string}` | undefined;
      const POOL_ADDRESS = process.env.NEXT_PUBLIC_SHIELDED_POOL_ADDRESS as `0x${string}` | undefined;

      let merklePath: string[] = [];
      const leafCount = 1;
      const leafIndex = 0;

      if (DEPLOYER_KEY && ZK_AGG_ADDRESS && POOL_ADDRESS && circuit === "withdraw") {
        const publicClient = createPublicClient({
          chain: baseSepolia,
          transport: http("https://sepolia.base.org"),
        });

        // Compute the statement leaf by calling ShieldedPool.statementHash on-chain.
        // This guarantees exact match with what _verifyAttestation() will verify.
        const inputs = (publicSignals as string[]).map((s) => BigInt(s));
        const leaf = await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: SHIELDED_POOL_ABI,
          functionName: "statementHash",
          args: [inputs],
        });

        // Single-leaf aggregation root: keccak256(abi.encodePacked(leaf))
        // Matches Merkle.sol's single-leaf logic in ZkVerifyAggregation tests
        const aggRoot = keccak256(encodePacked(["bytes32"], [leaf as `0x${string}`]));

        // Derive a unique aggregation ID — use Volta's aggregationId if available,
        // otherwise fall back to a timestamp-based ID
        const finalAggId = aggregationId !== 0 ? aggregationId : Math.floor(Date.now() / 1000);

        const account = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`);
        const walletClient = createWalletClient({
          account,
          chain: baseSepolia,
          transport: http("https://sepolia.base.org"),
        });

        await walletClient.writeContract({
          account,
          address: ZK_AGG_ADDRESS,
          abi: ZK_AGG_ABI,
          functionName: "submitAggregation",
          args: [BigInt(DOMAIN_ID), BigInt(finalAggId), aggRoot],
        });

        aggregationId = finalAggId;
      }

      return NextResponse.json({
        statement,
        aggregationId,
        domainId: DOMAIN_ID,
        merklePath,
        leafCount,
        leafIndex,
        txHash: result.txHash,
      });
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error("[zkverify route]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
