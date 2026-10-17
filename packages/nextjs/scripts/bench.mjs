#!/usr/bin/env node
// Benchmark: a room of phones tapping at once on Monad testnet, against the deployed EnterMarket.
// Funds N fresh burners like /api/drip does and asks one question per 50 phones. Every phone signs its own answer
// tx, and all of them are broadcast at the same moment. We record when each tx lands in a block, the gas and fees,
// time the batch payout of the winners, sweep leftover MON back to the funder, and write docs/benchmark-<phones>.json.
//
// Real phones each have their own connection; from one machine the public RPC rate-limits (HTTP 429) 100 parallel
// requests, so the taps go out as one JSON-RPC batch and inclusion is read from blocks instead of 100 receipt polls.
//
// Usage: AGENT_PRIVATE_KEY=0x... node scripts/bench.mjs [--phones 100] [--drip 0.05] [--reward 0.05]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  toBytes,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const PHONES = Number(flag("phones", "100"));
const DRIP = parseEther(flag("drip", "0.05"));
const REWARD = parseEther(flag("reward", "0.05"));
const MAX_QUORUM = 50;
// what the phone page's estimate comes to for a first answer, with headroom; Monad charges the full limit
const ANSWER_GAS = 230_000n;

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../contracts/deployedContracts.ts"), "utf8");
const address =
  process.env.ENTER_MARKET_ADDRESS ?? src.match(/10143:\s*{\s*EnterMarket:\s*{\s*address:\s*"(0x[0-9a-fA-F]{40})"/)[1];
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
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "answer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "option", type: "uint8" },
      { name: "codeHash", type: "bytes32" },
      { name: "expiry", type: "uint64" },
      { name: "signature", type: "bytes" },
    ],
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
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
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
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "winner", type: "uint8", indexed: false },
      { name: "perWinner", type: "uint256", indexed: false },
      { name: "winners", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paid",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "voter", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
];

const rpc = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc, { retryCount: 6 }) });
const batched = createPublicClient({
  chain: monadTestnet,
  transport: http(rpc, { batch: { batchSize: 100, wait: 0 } }),
});
const funder = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const funderWallet = createWalletClient({
  account: funder,
  chain: monadTestnet,
  transport: http(rpc, { retryCount: 6 }),
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = hash => pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 120_000 });
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    await sleep(300);
  }
  return out;
}

// the public RPC is load-balanced and can report a stale pending nonce, so count the funder's nonce here
let nonce = await pub.getTransactionCount({ address: funder.address, blockTag: "pending" });

// Sign locally: when the transport retries a send the node already holds, Monad rejects the resend with the same
// error as a nonce clash, so a failed send only counts as failed if the tx is not known.
async function funderSend({ functionName, args, ...tx }) {
  const n = nonce++;
  const data = functionName ? encodeFunctionData({ abi, functionName, args }) : undefined;
  const prepared = await funderWallet.prepareTransactionRequest({ ...tx, data, nonce: n });
  const serializedTransaction = await funderWallet.signTransaction(prepared);
  const hash = keccak256(serializedTransaction);
  // a node behind the load balancer that has not seen our previous tx yet rejects this one, so resend it
  for (let attempt = 1; ; attempt++) {
    try {
      await pub.sendRawTransaction({ serializedTransaction });
      return hash;
    } catch (err) {
      if (await pub.getTransaction({ hash }).then(Boolean, () => false)) return hash;
      if (attempt >= 8) throw err;
      await sleep(500 * attempt);
    }
  }
}

// 1. one question per 50 phones
const groups = Math.ceil(PHONES / MAX_QUORUM);
const ids = [];
for (let g = 0; g < groups; g++) {
  const quorum = Math.min(MAX_QUORUM, PHONES - g * MAX_QUORUM);
  const hash = await funderSend({
    to: address,
    functionName: "ask",
    args: [`Benchmark room ${g + 1}: press ENTER`, ["ENTER", "Esc"], quorum, 600n],
    value: REWARD,
  });
  const [asked] = parseEventLogs({ abi, logs: (await wait(hash)).logs, eventName: "Asked" });
  ids.push({ id: asked.args.id, quorum });
  console.log(`question #${asked.args.id}: quorum ${quorum}`);
}

// 2. fund the phones like the gas drip does
const phones = Array.from({ length: PHONES }, () => privateKeyToAccount(generatePrivateKey()));
let t = Date.now();
await inChunks(phones, 10, async p => wait(await funderSend({ to: p.address, value: DRIP })));
console.log(`funded ${PHONES} phones with ${formatEther(DRIP)} MON each in ${Date.now() - t} ms`);

// 3. every phone signs its own tap; 2 of 3 press ENTER so there is a clear majority
const fees = await pub.estimateFeesPerGas();
// each phone also needs an event pass; the funder is the contract's gatekeeper, so it signs them like /api/redeem does
const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
const passes = await Promise.all(
  phones.map(async (p, i) => {
    const codeHash = keccak256(toBytes(`bench-${Date.now()}-${i}`));
    const digest = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
        [address, BigInt(monadTestnet.id), p.address, codeHash, expiry],
      ),
    );
    return { codeHash, signature: await funder.signMessage({ message: { raw: digest } }) };
  }),
);
const signed = await Promise.all(
  phones.map((p, i) =>
    p.signTransaction({
      chainId: monadTestnet.id,
      type: "eip1559",
      to: address,
      data: encodeFunctionData({
        abi,
        functionName: "answer",
        args: [
          ids[Math.floor(i / MAX_QUORUM)].id,
          i % 3 === 2 ? 1 : 0,
          passes[i].codeHash,
          expiry,
          passes[i].signature,
        ],
      }),
      nonce: 0,
      gas: ANSWER_GAS,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    }),
  ),
);

const startBlock = await pub.getBlockNumber();
t = Date.now();
const hashes = signed.map(tx => keccak256(tx));

// watch blocks from the first tap on, so each tap's inclusion time is known whichever wave it went out in
const landed = new Map();
const pending = new Set(hashes);
const watching = (async () => {
  for (let next = startBlock + 1n; pending.size > 0 && Date.now() - t < 60_000; ) {
    const head = await pub.getBlockNumber();
    for (; next <= head; next++) {
      const block = await pub.getBlock({ blockNumber: next });
      for (const hash of block.transactions) {
        if (pending.delete(hash)) landed.set(hash, { block: Number(next), seenAt: Date.now() });
      }
    }
    await sleep(100);
  }
})();

// the public RPC allows 50 requests/s per IP; a real room has one IP per phone, so from here we send in waves
const WAVE = 40;
const sent = [];
for (let i = 0; i < signed.length; i += WAVE) {
  const wave = signed.slice(i, i + WAVE).map(async (serializedTransaction, k) => {
    const sentAt = Date.now();
    return batched.sendRawTransaction({ serializedTransaction }).then(
      () => ({ hash: hashes[i + k], sentAt }),
      err => ({ hash: hashes[i + k], sentAt, error: err.details ?? err.shortMessage ?? String(err) }),
    );
  });
  sent.push(...(await Promise.all(wave)));
  if (i + WAVE < signed.length) await sleep(1000);
}
const broadcastMs = Date.now() - t;
for (const s of sent) if (s.error) pending.delete(s.hash);
await watching;
const wallMs = Date.now() - t;

const receipts = await inChunks(
  sent.filter(s => landed.has(s.hash)),
  20,
  s => pub.getTransactionReceipt({ hash: s.hash }),
);
const byHash = new Map(receipts.map(r => [r.transactionHash, r]));
const taps = sent.map((s, i) => {
  const r = byHash.get(s.hash);
  if (!r) return { phone: i, status: s.error ? "rejected" : "not included", error: s.error, hash: s.hash };
  return {
    phone: i,
    question: Number(ids[Math.floor(i / MAX_QUORUM)].id),
    status: r.status,
    hash: s.hash,
    block: Number(r.blockNumber),
    sentMs: s.sentAt - t,
    tapToIncludedMs: landed.get(s.hash).seenAt - s.sentAt,
    gasUsed: Number(r.gasUsed),
    feeMon: Number(formatEther(ANSWER_GAS * r.effectiveGasPrice)),
    settled: parseEventLogs({ abi, logs: r.logs, eventName: "Settled" }).length > 0,
  };
});

// 4. the market agent pays each room's winners in one batch tx
const payouts = [];
for (const { id } of ids) {
  const start = Date.now();
  try {
    const hash = await funderSend({ to: address, functionName: "payout", args: [id, 50n] });
    const r = await wait(hash);
    payouts.push({
      question: Number(id),
      hash,
      status: r.status,
      winnersPaid: parseEventLogs({ abi, logs: r.logs, eventName: "Paid" }).length,
      gasUsed: Number(r.gasUsed),
      feeMon: Number(formatEther(r.gasUsed * r.effectiveGasPrice)),
      sendToReceiptMs: Date.now() - start,
    });
  } catch (err) {
    payouts.push({ question: Number(id), status: "error", error: err.shortMessage ?? String(err) });
  }
}

const ok = taps.filter(x => x.status === "success");
const seen = ok.map(x => x.tapToIncludedMs);
const blocks = [...new Set(ok.map(x => x.block))];
const summary = {
  date: new Date().toISOString(),
  chain: "Monad testnet (10143)",
  rpc,
  contract: address,
  phones: PHONES,
  questions: ids.map(q => Number(q.id)),
  succeeded: ok.length,
  failed: taps.length - ok.length,
  broadcastMs,
  allIncludedMs: Math.max(...ok.map(x => landed.get(x.hash).seenAt)) - t,
  tapToIncludedMs: { p50: pct(seen, 50), p90: pct(seen, 90), max: Math.max(...seen) },
  blocksSpanned: blocks.length,
  // Monad charges (and its receipts report) the gas limit, so this is what each tap paid for
  answerGasCharged: Number(ANSWER_GAS),
  quorumTaps: ok.filter(x => x.settled).map(x => ({ hash: x.hash, gasUsed: x.gasUsed })),
  payouts,
  errors: [...new Set(taps.filter(x => x.error).map(x => x.error.split("\n")[0]))],
  wallClockMs: wallMs,
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(join(here, `../../../docs/benchmark-${PHONES}.json`), JSON.stringify({ summary, taps }, null, 2));

// 5. settle anything that missed quorum, then sweep what is left on the phones back to the funder
for (const { id } of ids) {
  try {
    await funderSend({ to: address, functionName: "settle", args: [id] });
  } catch {
    // already settled on quorum
  }
}
const sweepFees = await pub.estimateFeesPerGas();
const sweepCost = 21_000n * sweepFees.maxFeePerGas;
const swept = await inChunks(phones, 10, async p => {
  const balance = await pub.getBalance({ address: p.address });
  if (balance <= sweepCost * 2n) return 0n;
  const wallet = createWalletClient({ account: p, chain: monadTestnet, transport: http(rpc, { retryCount: 6 }) });
  return wallet
    .sendTransaction({ to: funder.address, value: balance - sweepCost, gas: 21_000n })
    .then(() => balance - sweepCost)
    .catch(() => 0n);
});
console.log(`swept ${formatEther(swept.reduce((a, b) => a + b, 0n))} MON back to ${funder.address}`);
