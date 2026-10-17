#!/usr/bin/env node
// Claude Code PreToolUse hook: before the coding agent runs `git push`, it buys the decision from ENTER Market over
// x402 instead of stopping for you. The room votes on their phones, the majority settles on Monad, and the hook
// tells Claude Code to go ahead or not. Anything else passes through untouched.
//
// .claude/settings.json in the repo the agent works on:
//   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
//       { "type": "command", "command": "node /path/to/enter-market/packages/nextjs/scripts/claude-hook.mjs",
//         "timeout": 300 } ] } ] } }
// Env: AGENT_PRIVATE_KEY (pays in USDC), ENTER_MARKET_URL (default https://enter-market.vercel.app),
//      ENTER_QUORUM (default 3), ENTER_TTL seconds (default 120)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const command = input.tool_input?.command ?? "";
if (input.tool_name !== "Bash" || !/\bgit\s+push\b/.test(command)) process.exit(0);

const decide = (permissionDecision, permissionDecisionReason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
    }),
  );
  process.exit(0);
};

const YES = "Ship it 🚀";
const NO = "No. Go home.";
const repo = basename(input.cwd ?? process.cwd());
const resultFile = join(mkdtempSync(join(tmpdir(), "enter-market-")), "result.json");
const agent = spawn(
  process.execPath,
  [
    join(dirname(fileURLToPath(import.meta.url)), "agent.mjs"),
    "--question",
    `Claude Code wants to run "${command.slice(0, 80)}" in ${repo}. Let it?`.slice(0, 200),
    "--options",
    `${YES}|${NO}`,
    "--x402",
    process.env.ENTER_MARKET_URL || "https://enter-market.vercel.app",
    "--quorum",
    process.env.ENTER_QUORUM || "3",
    "--ttl",
    process.env.ENTER_TTL || "120",
    "--result-file",
    resultFile,
  ],
  // the agent's progress goes to stderr, so it shows in Claude Code's hook output without breaking our JSON
  { stdio: ["ignore", process.stderr, process.stderr] },
);

agent.on("exit", code => {
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    // no answer from the room: hand the decision back to the human, as without the hook
    return decide("ask", `ENTER Market could not get an answer (agent exited ${code}); asking you instead.`);
  }
  const tally = `${result.counts.join(" vs ")} on ENTER Market question #${result.id} (${result.contract} on Monad testnet)`;
  if (result.choice === YES) decide("allow", `The room voted "${YES}", ${tally}.`);
  if (result.choice === NO) decide("deny", `The room voted "${NO}", ${tally}. Do not push; save the work for later.`);
  decide("ask", `Nobody in the room answered question #${result.id}; asking you instead.`);
});
