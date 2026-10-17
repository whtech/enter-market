import { NextResponse } from "next/server";
import { createWalletClient, encodeFunctionData, http, keccak256, parseEther, parseEventLogs, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAIN,
  ENTER_MARKET_ABI,
  ENTER_MARKET_ADDRESS,
  RPC_URL,
  fetchLatestQuestion,
  publicClient,
} from "~~/utils/enterMarket";
import { issueInvite, signPass } from "~~/utils/eventPass";
import { marketAccount, sendFromMarket } from "~~/utils/marketWallet";

// Solo mode for people who are not in the room (remote judges). "start" hands the visitor a one-time invite and has
// the market agent ask a quorum-2 question; after the visitor taps, "bot" casts the second vote from a server-side
// phone so the round settles and pays out. It only runs while no other question is open, so it cannot disturb a live
// room, and at most once every COOLDOWN_MS.
const TRY_PREFIX = "Try round:";
const COOLDOWN_MS = 90_000;
const REWARD = parseEther("0.02");
const BOT_GAS = parseEther("0.2");
let lastStart = 0;

const botAccount = () =>
  privateKeyToAccount(keccak256(toBytes(`${process.env.DRIP_PRIVATE_KEY}:enter-market-try-bot`)));

async function start() {
  const latest = await fetchLatestQuestion();
  if (latest && !latest.settled && Number(latest.deadline) * 1000 > Date.now()) {
    return NextResponse.json({ error: "a question is open right now, try again in a minute" }, { status: 409 });
  }
  if (Date.now() - lastStart < COOLDOWN_MS) {
    return NextResponse.json({ error: "someone just started a round, try again in a minute" }, { status: 429 });
  }
  lastStart = Date.now();
  const hash = await sendFromMarket({
    to: ENTER_MARKET_ADDRESS,
    data: encodeFunctionData({
      abi: ENTER_MARKET_ABI,
      functionName: "ask",
      args: [`${TRY_PREFIX} commit and push to main on a Friday?`, ["Ship it 🚀", "No. Go home."], 2, 120n],
    }),
    value: REWARD,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  const [asked] = parseEventLogs({ abi: ENTER_MARKET_ABI, logs: receipt.logs, eventName: "Asked" });
  return NextResponse.json({ code: issueInvite(Date.now()), id: asked.args.id.toString(), askTx: hash });
}

async function botVote(id: bigint) {
  const latest = await fetchLatestQuestion();
  if (
    !latest ||
    latest.id !== id ||
    !latest.text.startsWith(TRY_PREFIX) ||
    latest.settled ||
    latest.answerCount !== 1
  ) {
    return NextResponse.json({ skipped: "not a try round waiting for its second vote" });
  }
  const bot = botAccount();
  const botAddress = bot.address as `0x${string}`;
  const balance = await publicClient.getBalance({ address: botAddress });
  if (balance < BOT_GAS / 4n) {
    const fund = await sendFromMarket({ to: botAddress, value: BOT_GAS });
    await publicClient.waitForTransactionReceipt({ hash: fund, pollingInterval: 250 });
  }
  const pass = await signPass(botAddress, `TRYBOT-${id}`);
  const args = [id, 1, pass.codeHash, BigInt(pass.expiry), pass.signature] as const;
  const call = { address: ENTER_MARKET_ADDRESS, abi: ENTER_MARKET_ABI, functionName: "answer", args } as const;
  const gas = (await publicClient.estimateContractGas({ ...call, account: bot })) + 60_000n;
  const wallet = createWalletClient({ account: bot, chain: CHAIN, transport: http(RPC_URL) });
  const hash = await wallet.writeContract({ ...call, gas });
  await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  return NextResponse.json({ hash });
}

export async function POST(req: Request) {
  if (!marketAccount) return NextResponse.json({ error: "market agent not configured" }, { status: 503 });
  const { action, id } = await req.json().catch(() => ({}));
  if (action === "start") return start();
  if (action === "bot" && typeof id === "string" && /^\d{1,10}$/.test(id)) return botVote(BigInt(id));
  return NextResponse.json({ error: "action must be start or bot" }, { status: 400 });
}
