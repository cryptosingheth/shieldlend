import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

// Server-side zkVerify submission — keeps seed phrase off the browser
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
        .execute({ proofData: { vk: vkey, proof, publicSignals }, domainId: 0 });

      let statement: string | null = null;
      let aggregationId: number | null = null;
      let statementPath: unknown = null;

      events.on(ZkVerifyEvents.IncludedInBlock, (eventData: { blockHash: string; statement: string; aggregationId: number }) => {
        statement = eventData.statement;
        aggregationId = eventData.aggregationId;
      });

      session.subscribe([
        {
          event: ZkVerifyEvents.NewAggregationReceipt,
          options: { domainId: 0 },
          callback: async (eventData: { data: { aggregationId: string; domainId: string }; blockHash: string }) => {
            const incomingAggId = parseInt(eventData.data.aggregationId.replace(/,/g, ""));
            if (aggregationId === incomingAggId) {
              statementPath = await session.getAggregateStatementPath(
                eventData.blockHash,
                parseInt(eventData.data.domainId),
                incomingAggId,
                statement!
              );
            }
          },
        },
      ]);

      const result = await transactionResult;

      // Wait up to 5 minutes for aggregation
      const deadline = Date.now() + 5 * 60 * 1000;
      while (!statementPath && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      return NextResponse.json({
        statement,
        aggregationId,
        statementPath,
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
