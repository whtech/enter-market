import { NextResponse } from "next/server";
import { createWalletClient, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN, RPC_URL, publicClient } from "~~/utils/enterMarket";

const DRIP_AMOUNT = parseEther(process.env.DRIP_AMOUNT || "0.05");
// a burner that still has this much gas does not get topped up again
const MIN_BALANCE = DRIP_AMOUNT / 2n;

const dripped = new Map<string, number>();

export async function POST(req: Request) {
  const key = process.env.DRIP_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) return NextResponse.json({ error: "drip not configured" }, { status: 503 });

  const { address } = await req.json().catch(() => ({}));
  if (typeof address !== "string" || !isAddress(address)) {
    return NextResponse.json({ error: "bad address" }, { status: 400 });
  }

  const last = dripped.get(address.toLowerCase());
  if (last && Date.now() - last < 60_000) return NextResponse.json({ skipped: "recently dripped" });

  const balance = await publicClient.getBalance({ address });
  if (balance >= MIN_BALANCE) return NextResponse.json({ skipped: "has gas", balance: balance.toString() });

  dripped.set(address.toLowerCase(), Date.now());
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: CHAIN, transport: http(RPC_URL) });
  const hash = await wallet.sendTransaction({ to: address, value: DRIP_AMOUNT });
  await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  return NextResponse.json({ hash });
}
