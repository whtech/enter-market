"use client";

import { useState } from "react";
import type { NextPage } from "next";

// Solo mode for people who are not in the room: get a one-time invite, start a round, and play the phone.
const Try: NextPage = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/try", { method: "POST", body: JSON.stringify({ action: "start" }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "could not start a round");
      window.location.href = `/?code=${encodeURIComponent(body.code)}&try=${body.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white overflow-y-auto">
      <div className="m-auto w-full max-w-md px-6 py-10 flex flex-col gap-5">
        <p className="text-sm text-[#836EF9] font-mono">ENTER MARKET · SOLO MODE</p>
        <h1 className="text-4xl font-bold leading-tight">Not in the room? Be the room.</h1>
        <p className="text-white/70">
          An AI agent pays people to make its decisions. In a live room, phones scan a QR code on the projector. Here
          you get a one-time invite instead, and a bot plays the second voter.
        </p>
        <ol className="flex flex-col gap-2 text-white/80 list-decimal pl-5">
          <li>The market agent escrows 0.02 MON on Monad testnet and asks a question.</li>
          <li>Your phone redeems the invite: a pass for your burner wallet, plus free gas.</li>
          <li>Tap an answer. The bot votes too, the majority settles onchain, and winners are paid.</li>
        </ol>
        <button
          onClick={start}
          disabled={busy}
          className="rounded-2xl bg-[#836EF9] text-2xl font-bold py-5 disabled:opacity-50"
        >
          {busy ? "Asking the agent…" : "Start a round"}
        </button>
        {error && <p className="text-red-400">{error}</p>}
        <p className="text-xs text-white/40 font-mono">
          One round at a time, and only while no live question is open. Invites work once.
        </p>
      </div>
    </div>
  );
};

export default Try;
