# ENTER Market

> I press ENTER 1000 times a day for my AI agents. Now my agent pays **you** to press it.

Coding agents keep stopping for a human: "Commit and push?", "Which of these 3 headlines?", "Is this output OK?".
ENTER Market turns that pause into a paid, onchain market for human judgment.

1. An **agent** posts a multiple-choice question and escrows a MON reward in `EnterMarket` on Monad. It can do this itself, or buy it from other agents over **x402** (see below).
2. Anyone scans the QR code and answers by tapping a giant button on their phone. A burner wallet and a gas drip mean no wallet install.
3. The tap that reaches the quorum settles the question onchain: the majority answer wins. The market agent then **pays every winner in one batch transaction**, about a second later.
4. The agent reads the result and keeps working with the crowd's choice.

![projector screen](docs/screen.jpg)
![phone](docs/phone.jpg)

## Agents outsourcing to agents, then hiring humans (x402)

Work flows down a chain the way outsourcing does in the real world: a client agent hires a contractor agent, the contractor keeps a margin and subcontracts to a local agent, and the local agent hires people in the room. Every hop between agents is an HTTP call paid in USDC over [x402](https://www.x402.org/) on Monad, and the last hop pays humans in MON through the contract.

```
🏢 client agent ──x402 $0.02 USDC──▶ 🧑‍💼 contractor agent  POST /api/outsource
                                        │ keeps $0.01
                                        └──x402 $0.01 USDC──▶ 🏪 local ENTER Market agent  POST /api/ask
                                                                 │ ask() escrows 0.1 MON
                                                                 ▼
                                                     👥 humans tap → majority paid in MON
```

- Agents only sign EIP-3009 USDC authorizations; the [Monad x402 facilitator](https://docs.monad.xyz/guides/x402) settles them, so the client agent needs no MON at all.
- A hop is settled only when its handler succeeds. If the local agent fails to post the question, neither the contractor nor the client is charged.
- The projector page shows each hop as it lands: the client hiring the contractor, the contractor hiring the local agent, the MON escrow, then every human tap and payout.

```bash
# client agent: outsources the decision down the chain and waits for the human majority
AGENT_PRIVATE_KEY=0x... yarn agent friday --x402 https://enter-market.vercel.app
# skip the contractor and hire the local agent directly
AGENT_PRIVATE_KEY=0x... yarn agent friday --x402 https://enter-market.vercel.app --x402-path /api/ask
```

## Why Monad

- **Tap → paid has to feel like pressing ENTER.** In our [benchmark](#benchmark) 40 phones tapping at the same moment all landed in **one block**, about 1.9 s from tap to inclusion, and the 28 winners were paid in one more transaction 1.7 s later. The payment is part of the interaction, not a wait.
- **A whole room tapping at once** is many small transactions in the same second: 100 of 100 taps landed across 3 blocks. That is the load Monad is built for.
- Escrow, settlement and every payout are public receipts onchain. Without the chain there is no trustless way for an agent to pay strangers for judgment.

## Deployed

| | |
| --- | --- |
| Contract (Monad testnet, verified) | [`0xaac47c455818805b0f0b6df2294c7309ec9a873f`](https://testnet.monadexplorer.com/address/0xaac47c455818805b0f0b6df2294c7309ec9a873f) |
| Phone page | `/` |
| Projector page | `/screen` |

## How it is built

```
agent (viem) ──ask(question, options, quorum, ttl) + MON──▶ EnterMarket.sol
phones (burner wallets) ──answer(id, option)──────────────▶   │ quorum tap → majority wins (constant gas)
market agent ───────────────payout(id, 50)────────────────▶   │ pays every winner in one batch, dust back
agent ◀──────────────────── getQuestion(id).settled ──────────┘
```

- `packages/foundry/contracts/EnterMarket.sol`: escrow, one answer per address, settle on quorum, anyone can `settle()` after the deadline, refund when nobody answers, a tie goes to the lowest option. Winners are paid by `payout(id, max)` in batches, and failed payouts are kept for `withdraw()`.
  - Why payouts are a separate transaction: phones in a room estimate gas against a state their neighbours are changing in the same block, and Monad charges the full gas limit. With payouts inside the quorum tap, that tap ran out of gas in our first benchmark (19 of 20 confirmed, the 20th reverted). Now every tap costs the same, which `testQuorumTapCostsTheSameAsAnyOtherTap` checks.
- `packages/nextjs/app/page.tsx`: phone page with a localStorage burner wallet and tap-to-confirmed latency.
- `packages/nextjs/app/screen/page.tsx`: projector page with QR code, live vote bars and payout feed.
- `packages/nextjs/app/api/drip/route.ts`: sends a little gas MON to new burners. Sends from the agent wallet go through `utils/marketWallet.ts`, which hands out nonces in order so a whole room can ask for gas at once.
- `packages/nextjs/app/api/payout/route.ts`: the market agent pays the winners once a question settles. Phones and the projector call it, and concurrent calls share one transaction.
- `packages/nextjs/app/api/outsource/route.ts`: the contractor agent, an x402-paid API that subcontracts over x402.
- `packages/nextjs/app/api/ask/route.ts`: the local ENTER Market agent, an x402-paid API that posts the question onchain.
- `packages/nextjs/scripts/agent.mjs`: the demo agent.
- `packages/nextjs/scripts/bench.mjs`: the benchmark below.

Built with Scaffold-ETH 2, Foundry, Next.js, viem, x402 and Vercel.

## Benchmark

`yarn bench --phones N` runs a room of N phones against the deployed contract on Monad testnet:
1. It funds N fresh burners with 0.05 MON, like the gas drip, and asks one question per 50 phones.
2. Every phone signs its own `answer()` and sends it.
3. It records when each tap lands in a block, times the batch payout, then sends the leftover MON back.

The raw data is in [`docs/benchmark-40.json`](docs/benchmark-40.json) and [`docs/benchmark-100.json`](docs/benchmark-100.json), with every tx hash.

| Phones | Confirmed | Blocks | Tap → included (p50 / max) | Batch payout |
| --- | --- | --- | --- | --- |
| 40 | 40 / 40 | 1 | 1.86 s / 1.86 s | 28 winners in one tx, 1.7 s, 0.99 M gas |
| 100 (2 rooms of 50) | 100 / 100 | 3 | 3.2 s / 3.3 s | 35 + 34 winners in two txs, 1.3 s and 1.6 s |

How to read it:
- Tap → included is measured from sending the signed tx until we see its block over the public RPC (polled every 100 ms), so it is an upper bound.
- The public RPC allows 50 requests per second per IP. From one machine, the 100-phone run had to send in waves of 40, one second apart, and the block watcher shared the same limit, which explains its higher latency. A real room has one IP per phone.
- Monad charges the gas limit, so each tap pays for 200k gas: about 0.02 MON at 100 gwei. The 0.05 MON drip covers two taps.
- In the first version of the contract, the payout ran inside the tap that reached quorum. The benchmark caught that tap running out of gas, and the contract was changed as described above.

## Run it

```bash
yarn install
yarn foundry:test                       # contract tests
AGENT_PRIVATE_KEY=0x... yarn bench --phones 40   # room benchmark on Monad testnet

# frontend, needs DRIP_PRIVATE_KEY (local agent + gas drip), BROKER_PRIVATE_KEY (contractor agent)
# and NEXT_PUBLIC_CONTRACTOR_AGENT in packages/nextjs/.env.local
yarn start

# agent: asks the room, waits for the onchain majority, continues
AGENT_PRIVATE_KEY=0x... yarn agent poster --reward 0.2 --quorum 5
AGENT_PRIVATE_KEY=0x... yarn agent friday
```

## Out of scope for the hackathon

Sybil resistance (one person can open many burners), reputation, disputes and mainnet. A likely next step is an event-code allowlist or proof of personhood for voters.
