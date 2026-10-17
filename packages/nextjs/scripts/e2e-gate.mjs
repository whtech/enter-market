#!/usr/bin/env node
// End-to-end check of the room-code gate: projector key, code redemption, pass-gated gas drip, onchain pass check,
// quorum and /api/payout. Runs against a local chain so it costs nothing:
//
//   anvil --chain-id 10143 --block-time 1
//   forge create contracts/EnterMarket.sol:EnterMarket --broadcast --constructor-args <market agent address> ...
//   NEXT_PUBLIC_MONAD_RPC_URL=http://127.0.0.1:8545 NEXT_PUBLIC_ENTER_MARKET_ADDRESS=<addr> PORT=3456 yarn dev
//   (fund the market agent on anvil, then)
//   DRIP_PRIVATE_KEY=0x... ADDR=<addr> node scripts/e2e-gate.mjs
import { createHmac } from "node:crypto";
import { createPublicClient, createWalletClient, http, keccak256, parseEther, parseEventLogs, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const BASE = "http://localhost:3456",
  RPC = "http://127.0.0.1:8545",
  ADDR = process.env.ADDR;
const chain = { ...monadTestnet, rpcUrls: { default: { http: [RPC] } } };
const abi = [
  {
    type: "function",
    name: "ask",
    stateMutability: "payable",
    inputs: [{ type: "string" }, { type: "string[]" }, { type: "uint16" }, { type: "uint64" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "answer",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }],
    outputs: [],
  },
  {
    type: "function",
    name: "pendingPayouts",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Asked",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "asker", type: "address", indexed: true },
      { name: "text", type: "string" },
      { name: "options", type: "string[]" },
      { name: "reward", type: "uint256" },
      { name: "quorum", type: "uint16" },
      { name: "deadline", type: "uint64" },
    ],
  },
];
const pub = createPublicClient({ chain, transport: http(RPC) });
const post = (path, body) =>
  fetch(BASE + path, { method: "POST", body: JSON.stringify(body) }).then(async r => ({
    status: r.status,
    body: await r.json(),
  }));
const check = (label, ok, extra = "") => console.log(`${ok ? "✔" : "✘"} ${label} ${extra}`);

const secret = keccak256(toBytes(`${process.env.DRIP_PRIVATE_KEY}:enter-market-event`));
const mac = t =>
  createHmac("sha256", secret).update(t).digest("base64url").replace(/[-_]/g, "").slice(0, 6).toUpperCase();
const screenKey = mac("screen").toLowerCase() + mac("screen-2").toLowerCase();

check("event-code without key is refused", (await fetch(BASE + "/api/event-code")).status === 403);
const { code } = await (await fetch(`${BASE}/api/event-code?key=${screenKey}`)).json();
check("projector gets a room code", /^[0-9A-Z]+-[0-9A-Z]{6}$/.test(code), code);

const phones = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()));
const bad = await post("/api/redeem", {
  code: code.slice(0, -1) + (code.endsWith("A") ? "B" : "A"),
  address: phones[0].address,
});
check("forged code is refused", bad.status === 400, bad.body.error);
const stale = await post("/api/redeem", { code: "1-ABCDEF", address: phones[0].address });
check("stale code is refused", stale.status === 400);
const passes = await Promise.all(phones.slice(0, 3).map(p => post("/api/redeem", { code, address: p.address })));
check(
  "3 phones redeem the same room code",
  passes.every(p => p.status === 200),
);

const noPassDrip = await post("/api/drip", { address: phones[3].address });
check("drip without a pass is refused", noPassDrip.status === 403);
const stolenDrip = await post("/api/drip", { address: phones[3].address, pass: passes[0].body });
check("drip with someone else's pass is refused", stolenDrip.status === 403);
const drips = await Promise.all(
  phones.slice(0, 3).map((p, i) => post("/api/drip", { address: p.address, pass: passes[i].body })),
);
check(
  "drip with own pass works",
  drips.every(d => d.status === 200 && d.body.hash),
  JSON.stringify(drips.map(d => d.status)),
);

// a fourth phone gets gas some other way and tries to vote without / with a stolen pass
const market = createWalletClient({
  account: privateKeyToAccount(process.env.DRIP_PRIVATE_KEY),
  chain,
  transport: http(RPC),
});
await pub.waitForTransactionReceipt({
  hash: await market.sendTransaction({ to: phones[3].address, value: parseEther("1") }),
});
const askHash = await market.writeContract({
  address: ADDR,
  abi,
  functionName: "ask",
  args: ["Gate test?", ["Yes", "No"], 3, 300n],
  value: parseEther("0.3"),
});
const [asked] = parseEventLogs({
  abi,
  logs: (await pub.waitForTransactionReceipt({ hash: askHash })).logs,
  eventName: "Asked",
});
const id = asked.args.id;
const vote = (p, opt, pass) =>
  createWalletClient({ account: p, chain, transport: http(RPC) }).writeContract({
    address: ADDR,
    abi,
    functionName: "answer",
    args: [id, opt, pass.codeHash, BigInt(pass.expiry ?? 0), pass.signature ?? "0x"],
    gas: 260_000n,
  });
const err = e => e.shortMessage?.split("\n").pop() ?? String(e);
const reverted = hash => pub.waitForTransactionReceipt({ hash }).then(r => r.status === "reverted");
check(
  "vote without a pass reverts onchain",
  await reverted(await vote(phones[3], 0, { codeHash: "0x" + "0".repeat(64) })),
);
check("vote with a stolen pass reverts onchain", await reverted(await vote(phones[3], 0, passes[0].body)));
const hashes = await Promise.all(phones.slice(0, 3).map((p, i) => vote(p, i === 2 ? 1 : 0, passes[i].body)));
const rs = await Promise.all(hashes.map(hash => pub.waitForTransactionReceipt({ hash })));
check(
  "3 phones with passes vote",
  rs.every(r => r.status === "success"),
  rs.map(r => r.gasUsed).join(","),
);
check(
  "quorum reached, payouts pending",
  (await pub.readContract({ address: ADDR, abi, functionName: "pendingPayouts", args: [id] })) === 3n,
);
const before = await pub.getBalance({ address: phones[0].address });
const pay = await post("/api/payout", { id: id.toString() });
check("/api/payout pays the winners", pay.status === 200 && !!pay.body.hash);
const after = await pub.getBalance({ address: phones[0].address });
check("winner got 0.15 MON", after - before === parseEther("0.15"), `${after - before}`);
