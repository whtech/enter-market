import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { encodeFunctionData, parseEther, parseEventLogs } from "viem";
import { ENTER_MARKET_ABI, ENTER_MARKET_ADDRESS, publicClient } from "~~/utils/enterMarket";
import { marketAccount, sendFromMarket } from "~~/utils/marketWallet";
import { paidRoute, x402Server } from "~~/utils/x402Server";

// The ENTER Market agent sells "ask the room" as a paid API. Buyer agents pay it in USDC over x402,
// and it escrows the MON reward onchain for the humans who answer.
const PRICE = process.env.X402_PRICE || "$0.01";
const REWARD = parseEther(process.env.ASK_REWARD || "0.1");
const MAX_TTL = 900;

const routeConfig = paidRoute(
  marketAccount?.address,
  PRICE,
  "Ask a room of humans a multiple-choice question; the majority answer is settled on Monad",
);

type AskBody = { question?: unknown; options?: unknown; quorum?: unknown; ttl?: unknown };

async function handler(request: NextRequest): Promise<NextResponse> {
  if (!marketAccount) return NextResponse.json({ error: "market agent not configured" }, { status: 503 });

  const body: AskBody = await request.json().catch(() => ({}));
  const { question, options } = body;
  const quorum = Number(body.quorum ?? 5);
  const ttl = Math.min(Number(body.ttl ?? 300), MAX_TTL);
  if (
    typeof question !== "string" ||
    !question ||
    question.length > 200 ||
    !Array.isArray(options) ||
    options.length < 2 ||
    options.length > 8 ||
    !options.every(o => typeof o === "string" && o.length > 0 && o.length <= 60) ||
    !(quorum >= 1 && quorum <= 50) ||
    !(ttl >= 30)
  ) {
    // a 4xx response means the x402 payment is not settled, so the buyer is not charged
    return NextResponse.json({ error: "need question, 2-8 options, quorum 1-50, ttl >= 30" }, { status: 400 });
  }

  const hash = await sendFromMarket({
    to: ENTER_MARKET_ADDRESS,
    data: encodeFunctionData({
      abi: ENTER_MARKET_ABI,
      functionName: "ask",
      args: [question, options as string[], quorum, BigInt(ttl)],
    }),
    value: REWARD,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  const [asked] = parseEventLogs({ abi: ENTER_MARKET_ABI, logs: receipt.logs, eventName: "Asked" });

  return NextResponse.json({
    id: asked.args.id.toString(),
    askTx: hash,
    reward: REWARD.toString(),
    contract: ENTER_MARKET_ADDRESS,
    marketAgent: marketAccount.address,
  });
}

export const POST = withX402(handler, routeConfig, x402Server);
