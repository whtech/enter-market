import { NextRequest, NextResponse } from "next/server";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { withX402 } from "@x402/next";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient } from "~~/utils/enterMarket";
import { paidRoute, x402Server } from "~~/utils/x402Server";

// The contractor agent: it wins the job from a client agent, keeps a margin, and subcontracts the work
// to the local ENTER Market agent (/api/ask), paying it over x402 as well.
const PRICE = process.env.OUTSOURCE_PRICE || "$0.02";

const brokerKey = process.env.BROKER_PRIVATE_KEY as `0x${string}` | undefined;
const brokerAccount = brokerKey ? privateKeyToAccount(brokerKey) : undefined;

const routeConfig = paidRoute(
  brokerAccount?.address,
  PRICE,
  "Contractor agent: gets your multiple-choice decision made by humans, subcontracted to a local crowd",
);

async function handler(request: NextRequest): Promise<NextResponse> {
  if (!brokerAccount) return NextResponse.json({ error: "contractor agent not configured" }, { status: 503 });

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: toClientEvmSigner(brokerAccount as Parameters<typeof toClientEvmSigner>[0], publicClient),
  });
  const payingFetch = wrapFetchWithPayment(fetch, client);

  const res = await payingFetch(new URL("/api/ask", request.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
  const body = await res.json().catch(() => ({}));
  // pass the subcontractor's failure through, so the client agent's payment is not settled either
  if (!res.ok) return NextResponse.json(body, { status: res.status });

  const settlement = res.headers.get("payment-response");
  return NextResponse.json({
    ...body,
    contractorAgent: brokerAccount.address,
    subcontractTx: settlement ? decodePaymentResponseHeader(settlement).transaction : undefined,
  });
}

export const POST = withX402(handler, routeConfig, x402Server);
