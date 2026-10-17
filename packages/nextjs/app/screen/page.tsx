"use client";

import { useEffect, useRef, useState } from "react";
import type { NextPage } from "next";
import { QRCodeSVG } from "qrcode.react";
import { formatEther } from "viem";
import {
  ENTER_MARKET_ABI,
  ENTER_MARKET_ADDRESS,
  EXPLORER,
  NO_WINNER,
  type Question,
  fetchLatestQuestion,
  publicClient,
} from "~~/utils/enterMarket";

type FeedItem = { key: string; kind: "answer" | "paid"; voter: string; text: string; hash: string };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const Screen: NextPage = () => {
  const [origin, setOrigin] = useState("");
  const [question, setQuestion] = useState<Question | null>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [txCount, setTxCount] = useState(0);
  const lastBlock = useRef<bigint>(0n);

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const q = await fetchLatestQuestion();
      if (stopped) return;
      setQuestion(q);

      // read new events block by block so a long-running screen never asks for a huge log range
      const latest = await publicClient.getBlockNumber();
      const from = lastBlock.current === 0n ? latest - 50n : lastBlock.current + 1n;
      if (from > latest) return;
      const logs = await publicClient.getContractEvents({
        address: ENTER_MARKET_ADDRESS,
        abi: ENTER_MARKET_ABI,
        fromBlock: from,
        toBlock: latest,
      });
      lastBlock.current = latest;
      if (stopped || logs.length === 0) return;
      const items: FeedItem[] = [];
      for (const log of logs) {
        const key = `${log.transactionHash}-${log.logIndex}`;
        if (log.eventName === "Answered") {
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
      setFeed(f => [...items.reverse(), ...f].slice(0, 14));
    };
    tick().catch(() => {});
    const timer = setInterval(() => tick().catch(() => {}), 1000);
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
        <div className="bg-white p-4 rounded-2xl self-center">{origin && <QRCodeSVG value={origin} size={300} />}</div>
        <p className="text-center font-mono mt-3 text-lg">{origin.replace(/^https?:\/\//, "")}</p>
        <p className="text-center font-mono text-white/60">{txCount} taps onchain this session</p>
        <div className="flex flex-col gap-2 mt-6 overflow-hidden font-mono text-lg">
          {feed.map(item => (
            <a
              key={item.key}
              href={`${EXPLORER}/tx/${item.hash}`}
              target="_blank"
              rel="noreferrer"
              className={item.kind === "paid" ? "text-green-400" : "text-white/80"}
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
