import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { RouteConfig } from "@x402/next";

// Server-only helpers shared by the paid agent APIs. Monad testnet USDC is built into @x402/evm >= 2.22.
export const X402_NETWORK = "eip155:10143" as const;

export const x402Server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL || "https://x402-facilitator.molandak.org" }),
).register(X402_NETWORK, new ExactEvmScheme());

export const paidRoute = (payTo: string | undefined, price: string, description: string): RouteConfig => ({
  accepts: {
    scheme: "exact",
    network: X402_NETWORK,
    payTo: payTo ?? "0x0000000000000000000000000000000000000000",
    price,
  },
  description,
  mimeType: "application/json",
});
