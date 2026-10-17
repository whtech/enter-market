#!/usr/bin/env node
// ENTER Market demo agent: it hits a decision it should not make alone, pays humans on Monad to make it,
// waits for the onchain majority, then carries on with that answer.
//
// Usage: AGENT_PRIVATE_KEY=0x... node scripts/agent.mjs [poster|friday] [--reward 0.1] [--quorum 5] [--ttl 120]
//        AGENT_PRIVATE_KEY=0x... node scripts/agent.mjs poster --x402 https://enter-market.vercel.app
//        ... --question "Deploy now?" --options "Yes|No" --result-file out.json   (any decision; used by claude-hook.mjs)
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const SCENARIOS = {
  poster: {
    intro: "I wrote 3 taglines for the Monad Blitz poster. I can't tell which one humans will like.",
    question: "Which tagline goes on the Monad Blitz poster?",
    options: ["Ship it in a block", "1 second to consensus", "Press ENTER, get paid"],
    next: choice => `writing poster.svg with headline "${choice}"`,
  },
  friday: {
    intro: "Tests pass. It's Friday 18:00. My training says ask a human first.",
    question: "Commit and push to main on a Friday?",
    options: ["Ship it 🚀", "No. Go home."],
    next: choice => (choice.startsWith("Ship") ? "git push origin main" : "saving a draft PR for Monday"),
  },
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const scenario = flag("question")
  ? {
      intro: "I hit a decision I should not make alone.",
      question: flag("question"),
      options: flag("options", "Yes|No").split("|"),
      next: choice => `going with "${choice}"`,
    }
  : SCENARIOS[args.find(a => SCENARIOS[a]) ?? "poster"];
const resultFile = flag("result-file");
const reward = parseEther(flag("reward", "0.1"));
const quorum = Number(flag("quorum", "5"));
const ttl = BigInt(flag("ttl", "120"));

const here = dirname(fileURLToPath(import.meta.url));
function contractAddress() {
  if (process.env.ENTER_MARKET_ADDRESS) return process.env.ENTER_MARKET_ADDRESS;
  const src = readFileSync(join(here, "../contracts/deployedContracts.ts"), "utf8");
  const match = src.match(/10143:\s*{\s*EnterMarket:\s*{\s*address:\s*"(0x[0-9a-fA-F]{40})"/);
  if (!match) throw new Error("EnterMarket is not deployed on Monad testnet yet (or set ENTER_MARKET_ADDRESS)");
  return match[1];
}

const abi = [
  {
    type: "function",
    name: "ask",
    stateMutability: "payable",
    inputs: [
      { name: "text", type: "string" },
      { name: "options", type: "string[]" },
      { name: "quorum", type: "uint16" },
      { name: "ttl", type: "uint64" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "payout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getQuestion",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "asker", type: "address" },
          { name: "deadline", type: "uint64" },
          { name: "quorum", type: "uint16" },
          { name: "answerCount", type: "uint16" },
          { name: "settled", type: "bool" },
          { name: "winner", type: "uint8" },
          { name: "reward", type: "uint256" },
          { name: "perWinner", type: "uint256" },
          { name: "text", type: "string" },
          { name: "options", type: "string[]" },
          { name: "counts", type: "uint256[]" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Asked",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "asker", type: "address", indexed: true },
      { name: "text", type: "string", indexed: false },
      { name: "options", type: "string[]", indexed: false },
      { name: "reward", type: "uint256", indexed: false },
      { name: "quorum", type: "uint16", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
    ],
  },
];

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) throw new Error("set AGENT_PRIVATE_KEY");
const rpc = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
const address = contractAddress();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = msg => console.log(`🤖 ${msg}`);
const explorer = "https://testnet.monadexplorer.com";

// --x402 <base url>: outsource the decision over x402 instead of escrowing MON ourselves.
// By default we hire the contractor agent (/api/outsource), which subcontracts to the local ENTER Market agent
// (/api/ask) that hires the humans. --x402-path /api/ask skips the middleman. This agent needs only USDC, no MON.
async function askViaX402(baseUrl) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: toClientEvmSigner(account, pub) });
  const payingFetch = wrapFetchWithPayment(fetch, client);
  const path = flag("x402-path", "/api/outsource");
  say(`Outsourcing the decision to ${baseUrl}${path} (x402, USDC)`);
  const res = await payingFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: scenario.question, options: scenario.options, quorum, ttl: Number(ttl) }),
  });
  if (!res.ok) throw new Error(`ENTER Market API answered ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const settlement = res.headers.get("payment-response");
  if (settlement) {
    const { transaction, payer } = decodePaymentResponseHeader(settlement);
    say(`Paid via x402 from ${payer} → ${explorer}/tx/${transaction}`);
  }
  if (body.contractorAgent) {
    say(
      `Contractor agent ${body.contractorAgent} subcontracted it to the local crowd agent → ${explorer}/tx/${body.subcontractTx}`,
    );
  }
  say(`ENTER Market agent ${body.marketAgent} escrowed ${formatEther(BigInt(body.reward))} MON for the humans`);
  say(`Question #${body.id} is live → ${explorer}/tx/${body.askTx}`);
  return BigInt(body.id);
}

async function askDirectly() {
  say(`Paying ${formatEther(reward)} MON for ${quorum} humans to decide: "${scenario.question}"`);
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName: "ask",
    args: [scenario.question, scenario.options, quorum, ttl],
    value: reward,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  const [asked] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Asked" });
  say(`Question #${asked.args.id} is live → ${explorer}/tx/${hash}`);
  return asked.args.id;
}

// Answers only decide the winner; paying them is a separate batch tx. Over x402 the local agent pays (we hold no MON).
async function payWinners(id) {
  if (x402Url) {
    const res = await fetch(`${x402Url.replace(/\/$/, "")}/api/payout`, {
      method: "POST",
      body: JSON.stringify({ id: id.toString() }),
    });
    return (await res.json()).hash;
  }
  const hash = await wallet.writeContract({ address, abi, functionName: "payout", args: [id, 50n] });
  await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  return hash;
}

say(scenario.intro);
const x402Url = flag("x402");
const id = x402Url ? await askViaX402(x402Url.replace(/\/$/, "")) : await askDirectly();
say("Waiting for humans to press ENTER…");

let seen = -1;
let settleSent = false;
for (;;) {
  const q = await pub.readContract({ address, abi, functionName: "getQuestion", args: [id] });
  if (q.answerCount !== seen) {
    seen = q.answerCount;
    console.log(`   ${q.answerCount}/${q.quorum} answers  [${q.counts.join(" | ")}]`);
  }
  if (q.settled) {
    if (q.winner === 255) {
      say("Nobody answered, refunded. Falling back to my own guess.");
    } else {
      const choice = q.options[q.winner];
      say(`✔ Crowd chose "${choice}"`);
      const payoutTx = await payWinners(id).catch(() => undefined);
      say(
        `Paid ${formatEther(q.perWinner)} MON to each of ${q.counts[q.winner]} winners` +
          (payoutTx ? ` → ${explorer}/tx/${payoutTx}` : " (already paid by the room)"),
      );
      say(`Continuing: ${scenario.next(choice)}`);
    }
    if (resultFile) {
      const winner = q.winner === 255 ? null : q.winner;
      writeFileSync(
        resultFile,
        JSON.stringify({
          id: id.toString(),
          question: q.text,
          choice: winner === null ? null : q.options[winner],
          winner,
          counts: q.counts.map(String),
          contract: address,
        }),
      );
    }
    break;
  }
  if (!settleSent && BigInt(Math.floor(Date.now() / 1000)) >= q.deadline) {
    settleSent = true;
    say("Deadline passed, settling with the answers I have.");
    await wallet.writeContract({ address, abi, functionName: "settle", args: [id] });
  }
  await sleep(500);
}
