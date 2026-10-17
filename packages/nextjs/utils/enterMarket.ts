import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";

export const CHAIN = monadTestnet;
export const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
export const EXPLORER = "https://testnet.monadexplorer.com";

const deployed = (deployedContracts as Record<number, Record<string, { address: `0x${string}` }>>)[CHAIN.id];

export const ENTER_MARKET_ADDRESS = (process.env.NEXT_PUBLIC_ENTER_MARKET_ADDRESS ||
  deployed?.EnterMarket?.address) as `0x${string}`;

export const ENTER_MARKET_ABI = [
  {
    type: "function",
    name: "answer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "option", type: "uint8" },
    ],
    outputs: [],
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
