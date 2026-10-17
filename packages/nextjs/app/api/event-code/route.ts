import { NextResponse } from "next/server";
import { issueCode, screenKey } from "~~/utils/eventPass";

// The projector polls this for the code it puts in the QR. It needs the screen key, or anyone could farm codes.
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!key || key !== screenKey()) return NextResponse.json({ error: "screen key required" }, { status: 403 });
  return NextResponse.json(issueCode(), { headers: { "cache-control": "no-store" } });
}
