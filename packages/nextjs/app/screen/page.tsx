"use client";

import { useEffect, useRef, useState } from "react";
import type { NextPage } from "next";
import { QRCodeSVG } from "qrcode.react";
import { formatEther, formatUnits, parseAbiItem } from "viem";
import {
  ENTER_MARKET_ABI,
  ENTER_MARKET_ADDRESS,
  EXPLORER,
  MONAD_USDC,
  NO_WINNER,
  type Question,
  fetchLatestQuestion,
  publicClient,
  requestPayout,
} from "~~/utils/enterMarket";

type FeedItem = { key: string; kind: "answer" | "paid" | "agent"; voter: string; text: string; hash: string };

const CONTRACTOR = process.env.NEXT_PUBLIC_CONTRACTOR_AGENT?.toLowerCase();

const USDC_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const Screen: NextPage = () => {
  const [origin, setOrigin] = useState("");
  const [question, setQuestion] = useState<Question | null>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [txCount, setTxCount] = useState(0);
  const lastBlock = useRef<bigint>(0n);
  const payoutRequested = useRef<bigint>(-1n);

  useEffect(() => setOrigin(window.location.origin), []);

  // a fresh one-time event code every few seconds: scanning it proves you are in the room (sybil resistance)
  const [eventCode, setEventCode] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("key");
    if (!key) {
      setCodeError("open this page as /screen?key=… to show join codes");
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const next = async () => {
      let wait = 5000;
      try {
        const res = await fetch(`/api/event-code?key=${encodeURIComponent(key)}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        setEventCode(body.code);
        setCodeError(undefined);
        wait = body.refreshInMs + 50;
      } catch (e) {
        setCodeError(e instanceof Error ? e.message : String(e));
      }
      timer = setTimeout(next, wait);
    };
    next();
    return () => clearTimeout(timer);
  }, []);
  const joinUrl = eventCode ? `${origin}/?code=${eventCode}` : origin;

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const q = await fetchLatestQuestion();
      if (stopped) return;
      setQuestion(q);
      // the projector stays open for the whole demo, so it makes sure the winners get paid
      if (q?.settled && q.winner !== NO_WINNER && payoutRequested.current !== q.id) {
        payoutRequested.current = q.id;
        requestPayout(q.id);
      }

      const latest = await publicClient.getBlockNumber();
      // Monad RPC caps eth_getLogs at 100 blocks, so catch up in windows of at most 100
      const from = lastBlock.current === 0n ? latest - 99n : lastBlock.current + 1n;
      if (from > latest) return;
      const to = from + 99n < latest ? from + 99n : latest;
      const logs = await publicClient.getContractEvents({
        address: ENTER_MARKET_ADDRESS,
        abi: ENTER_MARKET_ABI,
        fromBlock: from,
        toBlock: to,
      });
      // x402 payments from buyer agents land as USDC transfers to the agent that asks onchain
      const x402Payments = q
        ? await publicClient.getLogs({
            address: MONAD_USDC,
            event: USDC_TRANSFER,
            args: { to: [q.asker, CONTRACTOR].filter(Boolean) as `0x${string}`[] },
            fromBlock: from,
            toBlock: to,
          })
        : [];
      lastBlock.current = to;
      if (stopped || logs.length + x402Payments.length === 0) return;
      const ordered = [...x402Payments, ...logs].sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber),
      );
      const items: FeedItem[] = [];
      for (const log of ordered) {
        const key = `${log.transactionHash}-${log.logIndex}`;
        if (log.eventName === "Transfer") {
          const hop =
            log.args.to!.toLowerCase() === CONTRACTOR
              ? "🏢 client agent hired contractor"
              : log.args.from!.toLowerCase() === CONTRACTOR
                ? "🧑‍💼 contractor hired local agent"
                : "🏢 client agent hired local agent";
          items.push({
            key,
            kind: "agent",
            voter: log.args.from!,
            text: `${hop} · $${formatUnits(log.args.value!, 6)} USDC x402`,
            hash: log.transactionHash,
          });
        } else if (log.eventName === "Asked") {
          items.push({
            key,
            kind: "agent",
            voter: log.args.asker!,
            text: `🏪 local agent escrowed ${formatEther(log.args.reward!)} MON for humans`,
            hash: log.transactionHash,
          });
        } else if (log.eventName === "Answered") {
          items.push({ key, kind: "answer", voter: log.args.voter!, text: "pressed ENTER", hash: log.transactionHash });
        } else if (log.eventName === "Paid") {
          items.push({
            key,
            kind: "paid",
            voter: log.args.voter!,
            text: `+${formatEther(log.args.amount!)} MON`,
            hash: log.transactionHash,
          });
        }
      }
      setTxCount(c => c + logs.filter(l => l.eventName === "Answered").length);
      setFeed(f => {
        const seen = new Set(f.map(i => i.key));
        return [...items.filter(i => !seen.has(i.key)).reverse(), ...f].slice(0, 14);
      });
    };
    tick().catch(e => console.warn("[screen]", e));
    const timer = setInterval(() => tick().catch(e => console.warn("[screen]", e)), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const total = question ? question.counts.reduce((a, b) => a + b, 0n) : 0n;

  return (
    <div className="fixed inset-0 z-50 bg-black text-white grid grid-cols-[1fr_380px] gap-10 p-10 overflow-hidden">
      <div className="flex flex-col min-w-0">
        <p className="font-mono text-[#836EF9] text-xl">ENTER MARKET · an AI agent is paying you to press ENTER</p>
        {!question && <p className="text-4xl mt-10 text-white/60">Waiting for the agent to ask…</p>}
        {question && (
          <>
            <h1 className="text-5xl font-bold leading-tight mt-6">{question.text}</h1>
            <p className="font-mono text-2xl mt-4 text-white/70">
              reward {formatEther(question.reward)} MON · {question.answerCount}/{question.quorum} answers ·{" "}
              {question.settled ? "SETTLED" : "OPEN"}
            </p>
            <div className="flex flex-col gap-5 mt-10">
              {question.options.map((label, i) => {
                const votes = question.counts[i];
                const pct = total > 0n ? Number((votes * 100n) / total) : 0;
                const isWinner = question.settled && question.winner === i;
                return (
                  <div key={i}>
                    <div className="flex justify-between text-3xl mb-2">
                      <span className={isWinner ? "text-[#836EF9] font-bold" : ""}>
                        {isWinner && "✔ "}
                        {label}
                      </span>
                      <span className="font-mono">{votes.toString()}</span>
                    </div>
                    <div className="h-10 bg-white/10 rounded-xl overflow-hidden">
                      <div
                        className={`h-full rounded-xl transition-all duration-300 ${isWinner ? "bg-[#836EF9]" : "bg-white/70"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {question.settled && question.winner !== NO_WINNER && (
              <p className="text-3xl mt-10 text-green-400 font-bold">
                Crowd chose “{question.options[question.winner]}” · paid {formatEther(question.perWinner)} MON each
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col min-h-0">
        <div className="bg-white p-4 rounded-2xl self-center">{origin && <QRCodeSVG value={joinUrl} size={300} />}</div>
        <p className="text-center font-mono mt-3 text-lg">{origin.replace(/^https?:\/\//, "")}</p>
        {eventCode && <p className="text-center font-mono text-3xl font-bold text-[#836EF9]">{eventCode}</p>}
        {codeError && <p className="text-center font-mono text-red-400">{codeError}</p>}
        <p className="text-center font-mono text-white/60">{txCount} taps onchain this session</p>
        <div className="flex flex-col gap-2 mt-6 overflow-hidden font-mono text-lg">
          {feed.map(item => (
            <a
              key={item.key}
              href={`${EXPLORER}/tx/${item.hash}`}
              target="_blank"
              rel="noreferrer"
              className={
                item.kind === "paid" ? "text-green-400" : item.kind === "agent" ? "text-[#836EF9]" : "text-white/80"
              }
            >
              {short(item.voter)} {item.text}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Screen;
