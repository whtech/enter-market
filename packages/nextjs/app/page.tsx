"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  requestPayout,
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

// A voting pass from /api/redeem, bound to this burner and to the event code it scanned (see EnterMarket._checkPass).
type Pass = { codeHash: `0x${string}`; expiry: number; signature: `0x${string}` };
const passKey = (voter: string) => `enter-market-pass:${ENTER_MARKET_ADDRESS}:${voter}`.toLowerCase();

function loadPass(voter: string): Pass | null {
  try {
    const saved = JSON.parse(localStorage.getItem(passKey(voter)) ?? "null") as Pass | null;
    return saved && saved.expiry > Date.now() / 1000 ? saved : null;
  } catch {
    return null;
  }
}

// measured outside the component so the React compiler does not treat it as render work
const elapsedSince = (start?: number) => Math.round(performance.now() - (start ?? 0));

// covers settling the question (EnterMarket._decide) on top of a plain answer; Monad charges for the whole limit
const SETTLE_HEADROOM = 60_000n;

type Tap = { option: number; hash?: `0x${string}`; ms?: number; error?: string };

const Home: NextPage = () => {
  const [key, setKey] = useState<`0x${string}`>();
  const [question, setQuestion] = useState<Question | null>();
  const [myChoice, setMyChoice] = useState(0);
  const [balance, setBalance] = useState<bigint>();
  const [tap, setTap] = useState<Tap>();
  const [now, setNow] = useState(() => Date.now());
  const payoutRequested = useRef<bigint>(-1n);
  // undefined while checking, null when this phone still has to scan an event code
  const [pass, setPass] = useState<Pass | null>();
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string>();
  const [codeInput, setCodeInput] = useState("");

  useEffect(() => setKey(loadBurnerKey()), []);

  const account = useMemo(() => (key ? privateKeyToAccount(key) : undefined), [key]);
  const wallet = useMemo(
    () => (account ? createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) }) : undefined),
    [account],
  );

  const redeem = useCallback(
    async (code: string) => {
      if (!account) return;
      setJoining(true);
      setJoinError(undefined);
      try {
        const res = await fetch("/api/redeem", {
          method: "POST",
          body: JSON.stringify({ code, address: account.address }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "could not join");
        try {
          localStorage.setItem(passKey(account.address), JSON.stringify(body));
        } catch {
          // private mode: the pass lasts until the tab closes
        }
        setPass(body);
        window.history.replaceState(null, "", window.location.pathname);
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : String(e));
      } finally {
        setJoining(false);
      }
    },
    [account],
  );

  useEffect(() => {
    if (!account) return;
    const saved = loadPass(account.address);
    setPass(saved);
    const code = new URLSearchParams(window.location.search).get("code");
    if (!saved && code) redeem(code);
  }, [account, redeem]);

  // gas only comes with a pass, so a sybil's extra burners stay empty
  useEffect(() => {
    if (!account || !pass) return;
    fetch("/api/drip", { method: "POST", body: JSON.stringify({ address: account.address, pass }) }).catch(() => {});
  }, [account, pass]);

  const refresh = useCallback(async () => {
    if (!account) return;
    const q = await fetchLatestQuestion();
    setQuestion(q);
    // answers only decide the winner; ask the market agent to pay out (it shares one tx across all phones)
    if (q?.settled && q.winner !== NO_WINNER && payoutRequested.current !== q.id) {
      payoutRequested.current = q.id;
      requestPayout(q.id);
    }
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
    if (!wallet || !question || !pass || tap) return;
    setTap({ option });
    const started = elapsedSince();
    try {
      const call = {
        address: ENTER_MARKET_ADDRESS,
        abi: ENTER_MARKET_ABI,
        functionName: "answer",
        args: [question.id, option, pass.codeHash, BigInt(pass.expiry), pass.signature],
      } as const;
      // the estimate is taken before the neighbours' taps land; if this one turns out to reach the quorum it also
      // settles the question, so leave room for that or it runs out of gas
      const gas = (await publicClient.estimateContractGas({ ...call, account: wallet.account })) + SETTLE_HEADROOM;
      const hash = await wallet.writeContract({ ...call, gas });
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

      {pass === null && (
        <div className="m-auto w-full max-w-sm px-6 text-center flex flex-col gap-4">
          <h1 className="text-3xl font-bold">Join the room</h1>
          <p className="text-white/60">
            Scan the QR code on the big screen, or type the code under it. Only phones in the room can vote.
          </p>
          <input
            value={codeInput}
            onChange={e => setCodeInput(e.target.value.toUpperCase())}
            placeholder="ABC12-XYZ789"
            autoCapitalize="characters"
            className="rounded-xl bg-white/10 border border-white/20 px-4 py-3 text-xl font-mono text-center"
          />
          <button
            disabled={joining || !codeInput}
            onClick={() => redeem(codeInput)}
            className="rounded-2xl bg-[#836EF9] text-2xl font-bold py-4 disabled:opacity-40"
          >
            {joining ? "Joining…" : "Join"}
          </button>
          {joinError && <p className="text-red-400 text-sm">{joinError}</p>}
        </div>
      )}
      {pass === undefined && <p className="m-auto text-white/60">{joining ? "Joining…" : "Loading…"}</p>}
      {pass && question === undefined && <p className="m-auto text-white/60">Loading…</p>}
      {pass && question === null && (
        <p className="m-auto text-center px-6 text-white/60">Waiting for the agent to ask…</p>
      )}

      {pass && question && (
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
