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

// Server-side zkVerify submission — keeps seed phrase off the browser.
//
// V2 changes from V1:
//   - "collateral" → "collateral_ring" (maps to collateral_ring_vkey.json)
//   - "withdraw"   → "withdraw_ring"   (maps to withdraw_ring_vkey.json)
//   - submitAggregation path now also runs for "collateral_ring" (borrow proofs
//     verified on Volta before borrow() is called — no on-chain verifier needed)
//
// Flow:
//  1. Submit Groth16 proof to zkVerify Volta → verified on their chain.
//  2. For withdraw_ring: compute statement leaf, post single-leaf agg root to
//     ZkVerifyAggregation contract so ShieldedPool._verifyAttestation() passes.
//  3. Return { aggregationId, domainId, merklePath, leafCount, leafIndex, txHash }.

const DOMAIN_ID = 0;

// Valid circuit names (V2)
const VALID_CIRCUITS = ["deposit", "withdraw_ring", "collateral_ring"] as const;
type CircuitName = typeof VALID_CIRCUITS[number];

const SHIELDED_POOL_ABI = parseAbi([
  "function statementHash(uint256[] memory inputs) external view returns (bytes32)",
]);

const ZK_AGG_ABI = parseAbi([
  "function submitAggregation(uint256 domainId, uint256 aggregationId, bytes32 root) external",
]);

export async function POST(req: NextRequest) {
  try {
    const { circuit, proof, publicSignals, recipient, amount } = await req.json();

    if (!VALID_CIRCUITS.includes(circuit as CircuitName)) {
      return NextResponse.json(
        { error: `Invalid circuit. Expected one of: ${VALID_CIRCUITS.join(", ")}` },
        { status: 400 }
      );
    }

    const SEED_PHRASE = process.env.ZKVERIFY_SEED_PHRASE;
    if (!SEED_PHRASE) {
      return NextResponse.json({ error: "ZKVERIFY_SEED_PHRASE not set" }, { status: 500 });
    }

    const { zkVerifySession, ZkVerifyEvents, Library, CurveType } = await import("zkverifyjs");

    const keysDir = path.join(process.cwd(), "..", "circuits", "keys");
    // V2: circuit names map directly to vkey filenames
    // withdraw_ring → withdraw_ring_vkey.json
    // collateral_ring → collateral_ring_vkey.json
    // deposit → deposit_vkey.json (unchanged)
    const vkeyPath = path.join(keysDir, `${circuit}_vkey.json`);
    const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));

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

      const result = await transactionResult;

      // ── Post aggregation root for withdraw_ring proofs ────────────────────
      // collateral_ring proofs are verified by zkVerify before borrow() is called;
      // they don't need an on-chain aggregation root since V2 LendingPool doesn't
      // call _verifyAttestation(). Only withdraw_ring needs the agg root.
      const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
      const ZK_AGG_ADDRESS = process.env.ZKVERIFY_AGGREGATION_ADDRESS as `0x${string}` | undefined;
      const POOL_ADDRESS = process.env.NEXT_PUBLIC_SHIELDED_POOL_ADDRESS as `0x${string}` | undefined;

      let merklePath: string[] = [];
      const leafCount = 1;
      const leafIndex = 0;

      if (
        circuit === "withdraw_ring" &&
        DEPLOYER_KEY && ZK_AGG_ADDRESS && POOL_ADDRESS
      ) {
        const publicClient = createPublicClient({
          chain: baseSepolia,
          transport: http("https://sepolia.base.org"),
        });

        // withdraw_ring.circom public signal order (outputs before inputs in snarkjs):
        //   [0]    denomination_out  (public output — H-1 fix)
        //   [1-16] ring[0..15]
        //   [17]   nullifierHash
        //   [18]   root
        const sigs = publicSignals as string[];
        const denominationVal  = BigInt(sigs[0]);
        const nullifierHashVal = BigInt(sigs[17]);
        const rootVal          = BigInt(sigs[18]);

        // Build the 4-input statement that _verifyAttestation computes on-chain:
        //   statementHash([root, nullifierHash, uint160(recipient), denomination])
        // denomination replaces the free-form `amount` — the circuit has proven it.
        // MUST match exactly — any difference causes verifyProofAggregation to reject.
        const contractInputs = [
          rootVal,
          nullifierHashVal,
          BigInt(recipient) & ((1n << 160n) - 1n),
          denominationVal,
        ];

        const leaf = await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: SHIELDED_POOL_ABI,
          functionName: "statementHash",
          args: [contractInputs],
        });

        const aggRoot = keccak256(encodePacked(["bytes32"], [leaf as `0x${string}`]));
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
