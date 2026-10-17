import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";

export const CHAIN = monadTestnet;
export const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
export const EXPLORER = "https://testnet.monadexplorer.com";
export const MONAD_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

const deployed = (deployedContracts as Record<number, Record<string, { address: `0x${string}` }>>)[CHAIN.id];

export const ENTER_MARKET_ADDRESS = (process.env.NEXT_PUBLIC_ENTER_MARKET_ADDRESS ||
  deployed?.EnterMarket?.address) as `0x${string}`;

export const ENTER_MARKET_ABI = [
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
    name: "pendingPayouts",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "questionCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "choiceOfVoter",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ type: "uint8" }],
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
    name: "Answered",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "voter", type: "address", indexed: true },
      { name: "option", type: "uint8", indexed: false },
      { name: "answerCount", type: "uint16", indexed: false },
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
] as const;

export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

export type Question = {
  id: bigint;
  asker: string;
  deadline: bigint;
  quorum: number;
  answerCount: number;
  settled: boolean;
  winner: number;
  reward: bigint;
  perWinner: bigint;
  text: string;
  options: readonly string[];
  counts: readonly bigint[];
};

/** Latest question, or null when nothing has been asked yet. */
export async function fetchLatestQuestion(): Promise<Question | null> {
  const count = await publicClient.readContract({
    address: ENTER_MARKET_ADDRESS,
    abi: ENTER_MARKET_ABI,
    functionName: "questionCount",
  });
  if (count === 0n) return null;
  const id = count - 1n;
  const q = await publicClient.readContract({
    address: ENTER_MARKET_ADDRESS,
    abi: ENTER_MARKET_ABI,
    functionName: "getQuestion",
    args: [id],
  });
  return { id, ...q };
}

export const NO_WINNER = 255;

/** Asks the market agent to pay the winners of a settled question. Safe to call from every phone at once. */
export const requestPayout = (id: bigint) =>
  fetch("/api/payout", { method: "POST", body: JSON.stringify({ id: id.toString() }) }).catch(() => undefined);
