import { createHmac, timingSafeEqual } from "node:crypto";
import { type Hex, encodeAbiParameters, keccak256, recoverMessageAddress, toBytes } from "viem";
import { CHAIN, ENTER_MARKET_ADDRESS } from "~~/utils/enterMarket";
import { marketAccount } from "~~/utils/marketWallet";

// Server-only: room codes and voting passes (sybil resistance).
// The projector shows a new room code every SLOT_MS. A code is the time slot plus an HMAC, so the server checks it
// without storing anything. While it is fresh, any phone can trade it for a pass that the market agent (the contract's
// gatekeeper) signs for that phone's burner; the contract refuses votes without one. This keeps voting to people in the
// room; it does not stop one person in the room from scripting several burners.
const SLOT_MS = 10_000;
// a code shown on screen stays redeemable this long, so slow scanners still get in
const CODE_TTL_MS = 90_000;
// a pass covers every question of the event
const PASS_TTL_S = 12 * 60 * 60;

const key = process.env.DRIP_PRIVATE_KEY;
const secret = key ? keccak256(toBytes(`${key}:enter-market-event`)) : undefined;

const mac = (text: string) =>
  createHmac("sha256", secret!).update(text).digest("base64url").replace(/[-_]/g, "").slice(0, 6).toUpperCase();

/** Unlocks /api/event-code, so only the projector can show codes. Open the screen at /screen?key=<this>. */
export const screenKey = () => (secret ? mac("screen").toLowerCase() + mac("screen-2").toLowerCase() : undefined);

export function issueCode(now = Date.now()) {
  const slot = Math.floor(now / SLOT_MS)
    .toString(36)
    .toUpperCase();
  return { code: `${slot}-${mac(slot)}`, refreshInMs: SLOT_MS - (now % SLOT_MS) };
}

export function isValidCode(code: string, now = Date.now()) {
  const match = /^([0-9A-Z]{1,10})-([0-9A-Z]{6})$/.exec(code);
  if (!secret || !match) return false;
  const [, slot, given] = match;
  const issuedAt = parseInt(slot, 36) * SLOT_MS;
  if (now - issuedAt > CODE_TTL_MS || issuedAt > now + SLOT_MS) return false;
  return timingSafeEqual(Buffer.from(mac(slot)), Buffer.from(given));
}

export type Pass = { codeHash: Hex; expiry: number; signature: Hex };

// must match EnterMarket.passDigest
const passDigest = (voter: `0x${string}`, codeHash: Hex, expiry: number) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
      [ENTER_MARKET_ADDRESS, BigInt(CHAIN.id), voter, codeHash, BigInt(expiry)],
    ),
  );

export async function signPass(voter: `0x${string}`, code: string): Promise<Pass> {
  // a room code is shared by everyone who scans it, so each pass gets its own hash; the contract's one-address-per-hash
  // rule is there for one-time invite codes, which would hash the code alone
  const codeHash = keccak256(toBytes(`${code}:${voter.toLowerCase()}`));
  const expiry = Math.floor(Date.now() / 1000) + PASS_TTL_S;
  const signature = await marketAccount!.signMessage({ message: { raw: passDigest(voter, codeHash, expiry) } });
  return { codeHash, expiry, signature };
}

/** True when `pass` is one we signed for `voter` and it has not expired. */
export async function isOwnPass(voter: `0x${string}`, pass: Partial<Pass>) {
  const { codeHash, expiry, signature } = pass;
  if (!marketAccount || !codeHash || !signature || !expiry || expiry < Date.now() / 1000) return false;
  const signer = await recoverMessageAddress({
    message: { raw: passDigest(voter, codeHash, expiry) },
    signature,
  }).catch(() => undefined);
  return signer === marketAccount.address;
}
