# ENTER Market

> I press ENTER 1000 times a day for my AI agents. Now my agent pays **you** to press it.

Coding agents keep stopping for a human: "Commit and push?", "Which of these 3 headlines?", "Is this output OK?".
ENTER Market turns that pause into a paid, onchain market for human judgment.

1. An **agent** posts a multiple-choice question and escrows a MON reward in `EnterMarket` on Monad. It can do this itself, or buy it from other agents over **x402** (see below).
2. People in the room scan the QR code on the projector and answer by tapping a giant button on their phone. A burner wallet and a gas drip mean no wallet install. The QR carries a room code that rotates every 10 seconds, and the contract refuses votes without a pass for it (see [Sybil resistance](#sybil-resistance)).
3. The tap that reaches the quorum settles the question onchain: the majority answer wins. The market agent then **pays every winner in one batch transaction**, about a second later.
4. The agent reads the result and keeps working with the crowd's choice.

**Try it without being in the room:** open [enter-market.vercel.app/try](https://enter-market.vercel.app/try) on your phone. You get a one-time invite, the agent asks a question, you tap, a bot casts the second vote, and the winners are paid on Monad testnet. Demo video, narrated, with English and Chinese subtitles: [English voice](docs/demo-en.mp4) · [中文配音](docs/demo-zh.mp4). Slides: [`docs/enter-market.pptx`](docs/enter-market.pptx). Story in English and Chinese: [`docs/story.md`](docs/story.md).

![projector screen](docs/screen.jpg)
![phone](docs/phone.jpg)

## A real coding agent asks the room before `git push`

[`packages/nextjs/scripts/claude-hook.mjs`](packages/nextjs/scripts/claude-hook.mjs) is a Claude Code `PreToolUse` hook. When the agent is about to run `git push`, the hook buys the decision over x402, the room votes, and the onchain majority becomes Claude Code's permission decision: `allow`, `deny`, or back to you if nobody answers.

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "node <repo>/packages/nextjs/scripts/claude-hook.mjs", "timeout": 300 } ] } ] } }
```

We ran it with a real Claude Code session (`claude -p "… Push it to origin"`) on Monad testnet. Claude Code called `git push origin main`, and the hook asked question #3: *"Claude Code wants to run "git push origin main …" in app. Let it?"*. Three phones voted 2 to 1 for "Ship it 🚀", so the push went through. The full record, with every tx hash, is in [`docs/claude-code-hook.md`](docs/claude-code-hook.md).

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
| Contract (Monad testnet, verified) | [`0xd544a6d7f543930454a848780706afbab6c4e4ac`](https://testnet.monadexplorer.com/address/0xd544a6d7f543930454a848780706afbab6c4e4ac) |
| Phone page | `/` |
| Projector page | `/screen?key=…` (the key unlocks the rotating room code) |
| Solo mode for remote judges | [`/try`](https://enter-market.vercel.app/try) |

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
- `packages/nextjs/app/api/event-code/route.ts` and `app/api/redeem/route.ts`: the projector's rotating room code (behind a screen key) and the pass a phone gets for it, signed by the market agent. See `utils/eventPass.ts`.
- `packages/nextjs/app/api/payout/route.ts`: the market agent pays the winners once a question settles. Phones and the projector call it, and concurrent calls share one transaction.
- `packages/nextjs/app/api/outsource/route.ts`: the contractor agent, an x402-paid API that subcontracts over x402.
- `packages/nextjs/app/api/ask/route.ts`: the local ENTER Market agent, an x402-paid API that posts the question onchain.
- `packages/nextjs/scripts/agent.mjs`: the demo agent.
- `packages/nextjs/scripts/bench.mjs`: the benchmark below.
- `packages/nextjs/scripts/claude-hook.mjs`: the Claude Code hook above.
- `packages/nextjs/app/try/page.tsx` and `app/api/try/route.ts`: solo mode with a one-time invite and a bot voter.
- `packages/nextjs/scripts/e2e-gate.mjs`: end-to-end check of the room-code gate, gas drip, onchain pass check, quorum and payout against a local chain (14 checks).

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

## Sybil resistance

A burner wallet costs nothing, so without a gate one person could vote with a hundred of them. Voting needs a pass:

1. The projector (`/screen?key=…`) shows a QR with a room code that changes every 10 seconds. A code is the time slot plus an HMAC, so the server checks it without a database, and it expires after 90 seconds.
2. A phone trades the code for a pass: the market agent signs (contract, chain, burner address, code hash, expiry).
3. `answer()` checks the pass onchain against the contract's `gatekeeper`. A vote without a pass, or with a pass signed for another address, reverts. The gas drip also only funds burners holding their own pass.
4. The contract also binds every code hash to the first address that votes with it, so one-time invite codes (hashing the code alone) count exactly once.

What this does and does not stop: voting is limited to people who can see the projector, and passes cannot be shared or replayed. Someone in the room can still script several burners against a live code.

Roadmap, from what runs today to what closes that gap:

| Stage | Who can vote | One person, one vote? | Status |
| --- | --- | --- | --- |
| Room code | anyone who can see the projector | no: someone could script several burners | live |
| One-time invite codes (`INV…`) | one address per invite, enforced onchain (`passHolder`) | yes, as far as invites go to one person each | live: `/try` hands one to each remote visitor; an event can print them on badges |
| Proof of personhood | one human, checked before the gatekeeper signs (for example World ID) | yes | next |
| Reputation | voters weighted by how often they sided with the final majority | rewards honest answers | later |

For a live demo the room code is the right trade-off: everyone can see who is in the room, and the stakes are 0.1 MON.

## Economics

What one decision costs in the demo, and who gets what:

| Step | Paid by | Amount | To |
| --- | --- | --- | --- |
| Client agent hires the contractor | client agent | $0.02 USDC (x402) | contractor agent |
| Contractor hires the local agent | contractor agent | $0.01 USDC (x402), keeps $0.01 | local ENTER Market agent |
| Reward for the humans | local agent | 0.1 MON, escrowed | the majority, split equally |
| Gas for a new phone | local agent | 0.05 MON once (covers about two taps) | the voter's burner |

The agent sets the reward, so it prices a decision by what a wrong one would cost it. A coding agent that pushes broken code to main on a Friday costs a person an evening; paying a room a few cents to say "no" is cheap insurance. The local agent earns $0.01 per question and pays MON for the reward and gas. On mainnet it would price the x402 fee to cover those, which an operator can set with `X402_PRICE` and `ASK_REWARD`.

## Out of scope for the hackathon

Proof of personhood, reputation, disputes and mainnet.
