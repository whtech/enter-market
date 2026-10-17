"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NextPage } from "next";
import { createWalletClient, formatEther, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CHAIN,
  ENTER_MARKET_ABI,
  ENTER_MARKET_ADDRESS,
  EXPLORER,
  NO_WINNER,
  type Question,
  RPC_URL,
  fetchLatestQuestion,
  publicClient,
} from "~~/utils/enterMarket";

const BURNER_KEY = "enter-market-burner";

function loadBurnerKey(): `0x${string}` {
  try {
    const saved = localStorage.getItem(BURNER_KEY);
    if (saved) return saved as `0x${string}`;
    const fresh = generatePrivateKey();
    localStorage.setItem(BURNER_KEY, fresh);
    return fresh;
  } catch {
    return generatePrivateKey();
  }
}

// measured outside the component so the React compiler does not treat it as render work
const elapsedSince = (start?: number) => Math.round(performance.now() - (start ?? 0));

type Tap = { option: number; hash?: `0x${string}`; ms?: number; error?: string };

const Home: NextPage = () => {
  const [key, setKey] = useState<`0x${string}`>();
  const [question, setQuestion] = useState<Question | null>();
  const [myChoice, setMyChoice] = useState(0);
  const [balance, setBalance] = useState<bigint>();
  const [tap, setTap] = useState<Tap>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setKey(loadBurnerKey()), []);

  const account = useMemo(() => (key ? privateKeyToAccount(key) : undefined), [key]);
  const wallet = useMemo(
    () => (account ? createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) }) : undefined),
    [account],
  );

  useEffect(() => {
    if (!account) return;
    fetch("/api/drip", { method: "POST", body: JSON.stringify({ address: account.address }) }).catch(() => {});
  }, [account]);

  const refresh = useCallback(async () => {
    if (!account) return;
    const q = await fetchLatestQuestion();
    setQuestion(q);
    setBalance(await publicClient.getBalance({ address: account.address }));
    if (q) {
      const choice = await publicClient.readContract({
        address: ENTER_MARKET_ADDRESS,
        abi: ENTER_MARKET_ABI,
        functionName: "choiceOfVoter",
        args: [q.id, account.address],
      });
      setMyChoice(choice);
    }
  }, [account]);

  useEffect(() => {
    refresh().catch(() => {});
    const timer = setInterval(() => {
      setNow(Date.now());
      refresh().catch(() => {});
      // 2s keeps a full room of phones under the public RPC rate limit
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  // forget the last tap when a new question shows up
  useEffect(() => setTap(undefined), [question?.id]);

  const press = async (option: number) => {
    if (!wallet || !question || tap) return;
    setTap({ option });
    const started = elapsedSince();
    try {
      const hash = await wallet.writeContract({
        address: ENTER_MARKET_ADDRESS,
        abi: ENTER_MARKET_ABI,
        functionName: "answer",
        args: [question.id, option],
      });
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      setTap({ option, hash, ms: elapsedSince(started) });
      refresh().catch(() => {});
    } catch (e) {
      const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
      setTap({ option, error: message });
    }
  };

  const open = question && !question.settled && Number(question.deadline) * 1000 > now;
  const answered = myChoice > 0 || (tap && !tap.error);
  const chosen = myChoice > 0 ? myChoice - 1 : tap?.option;
  const won = question?.settled && question.winner !== NO_WINNER && chosen === question.winner && answered;
  const secondsLeft = question ? Math.max(0, Math.ceil(Number(question.deadline) - now / 1000)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white overflow-y-auto">
      <div className="flex justify-between items-center px-4 pt-4 text-xs text-white/60 font-mono">
        <span>ENTER MARKET</span>
        <span>{balance !== undefined ? `${Number(formatEther(balance)).toFixed(4)} MON` : "…"}</span>
      </div>

      {question === undefined && <p className="m-auto text-white/60">Loading…</p>}
      {question === null && <p className="m-auto text-center px-6 text-white/60">Waiting for the agent to ask…</p>}

      {question && (
        <div className="flex flex-col flex-1 px-4 pb-6">
          <p className="text-sm text-[#836EF9] font-mono mt-6">
            Agent asks · {formatEther(question.reward)} MON · {question.answerCount}/{question.quorum} answers
            {open && ` · ${secondsLeft}s`}
          </p>
          <h1 className="text-3xl font-bold leading-tight mt-2 mb-6">{question.text}</h1>

          <div className="flex flex-col gap-3 flex-1">
            {question.options.map((label, i) => {
              const isChosen = chosen === i && answered;
              const isWinner = question.settled && question.winner === i;
              return (
                <button
                  key={i}
                  disabled={!open || !!answered || !!tap}
                  onClick={() => press(i)}
                  className={`flex-1 min-h-24 rounded-2xl text-2xl font-bold px-4 transition-transform active:scale-95 border-4 ${
                    isWinner
                      ? "bg-[#836EF9] border-[#836EF9]"
                      : isChosen
                        ? "bg-white text-black border-white"
                        : "bg-white/10 border-white/20 disabled:opacity-40"
                  }`}
                >
                  {tap && !tap.hash && !tap.error && tap.option === i ? "↵ …" : label}
                  <span className="block text-sm font-mono opacity-70">{question.counts[i].toString()} votes</span>
                </button>
              );
            })}
          </div>

          <div className="mt-6 text-center font-mono min-h-20">
            {tap?.ms !== undefined && (
              <p className="text-lg">
                confirmed in <span className="text-[#836EF9] text-3xl font-bold">{tap.ms} ms</span>
              </p>
            )}
            {won && <p className="text-4xl font-bold text-green-400 mt-2">+{formatEther(question.perWinner)} MON 🎉</p>}
            {question.settled && answered && !won && <p className="text-white/60 mt-2">Majority went the other way.</p>}
            {question.settled && !answered && (
              <p className="text-white/60 mt-2">Settled. Wait for the next question.</p>
            )}
            {tap?.hash && (
              <a href={`${EXPLORER}/tx/${tap.hash}`} target="_blank" rel="noreferrer" className="underline text-xs">
                view tx
              </a>
            )}
            {tap?.error && <p className="text-red-400 text-sm break-words">{tap.error}</p>}
          </div>
        </div>
      )}
    </div>
  );
};

export default Home;
