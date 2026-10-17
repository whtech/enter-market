import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isValidCode, signPass } from "~~/utils/eventPass";
import { marketAccount } from "~~/utils/marketWallet";

// A phone trades the room code it scanned for a voting pass bound to its burner address.

export async function POST(req: Request) {
  if (!marketAccount) return NextResponse.json({ error: "market agent not configured" }, { status: 503 });

  const { code, address } = await req.json().catch(() => ({}));
  if (typeof address !== "string" || !isAddress(address)) {
    return NextResponse.json({ error: "bad address" }, { status: 400 });
  }
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!isValidCode(normalized)) {
    return NextResponse.json({ error: "code expired or wrong, scan the screen again" }, { status: 400 });
  }
  return NextResponse.json(await signPass(address as `0x${string}`, normalized));
}
