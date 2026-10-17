import { NextResponse } from "next/server";
import { encodeFunctionData } from "viem";
import { ENTER_MARKET_ABI, ENTER_MARKET_ADDRESS, publicClient } from "~~/utils/enterMarket";
import { marketWallet, sendFromMarket } from "~~/utils/marketWallet";

// The market agent pays the winners once a question settles. Answers only decide the winner, so a phone's tap
// stays cheap; this route pays everyone in one batch from the agent's wallet. Every phone and the projector call it,
// so concurrent calls for the same question share one transaction.
const BATCH = 50n;
const inflight = new Map<string, Promise<`0x${string}` | undefined>>();

async function pay(id: bigint) {
  const pending = await publicClient.readContract({
    address: ENTER_MARKET_ADDRESS,
    abi: ENTER_MARKET_ABI,
    functionName: "pendingPayouts",
    args: [id],
  });
  if (pending === 0n) return undefined;
  const hash = await sendFromMarket({
    to: ENTER_MARKET_ADDRESS,
    data: encodeFunctionData({ abi: ENTER_MARKET_ABI, functionName: "payout", args: [id, BATCH] }),
  });
  await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  return hash;
}

export async function POST(req: Request) {
  if (!marketWallet) return NextResponse.json({ error: "market agent not configured" }, { status: 503 });

  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !/^\d{1,10}$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  let job = inflight.get(id);
  if (!job) {
    job = pay(BigInt(id)).finally(() => inflight.delete(id));
    inflight.set(id, job);
  }
  try {
    const hash = await job;
    return NextResponse.json(hash ? { hash } : { skipped: "nothing to pay" });
  } catch (err) {
    // another instance paid the same batch first
    if (/NothingToPay/.test(String((err as Error)?.message))) return NextResponse.json({ skipped: "already paid" });
    throw err;
  }
}
