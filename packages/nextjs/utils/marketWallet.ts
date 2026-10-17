import { type Hash, type Hex, createWalletClient, http, keccak256 } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAIN, RPC_URL, publicClient } from "~~/utils/enterMarket";

// Server-only: the ENTER Market agent's hot wallet, shared by /api/drip, /api/ask and /api/payout.
// A whole room opens the phone page at once, so concurrent sends from this key must not reuse a nonce:
// the nonce manager hands out nonces in order within an instance, and sendFromMarket covers clashes across instances.
const key = process.env.DRIP_PRIVATE_KEY as `0x${string}` | undefined;

export const marketAccount = key ? privateKeyToAccount(key, { nonceManager }) : undefined;

export const marketWallet = marketAccount
  ? createWalletClient({ account: marketAccount, chain: CHAIN, transport: http(RPC_URL) })
  : undefined;

const MAX_ATTEMPTS = 5;

type MarketTx = { to: `0x${string}`; data?: Hex; value?: bigint };

export async function sendFromMarket(tx: MarketTx): Promise<Hash> {
  const wallet = marketWallet!;
  const account = marketAccount!;
  for (let attempt = 1; ; attempt++) {
    const prepared = await wallet.prepareTransactionRequest({ ...tx, account, chain: CHAIN });
    const serializedTransaction = await wallet.signTransaction(prepared);
    const hash = keccak256(serializedTransaction);
    try {
      await publicClient.sendRawTransaction({ serializedTransaction });
      return hash;
    } catch (err) {
      // The transport retries a send that timed out, and Monad answers a resend of a tx it already holds with the
      // same "higher priority" error as a real nonce clash. If ours is in, we are done; sending again would duplicate.
      if (await publicClient.getTransaction({ hash }).then(Boolean, () => false)) return hash;
      // a failed send leaves a gap in the locally counted nonces, so re-read it from the chain
      nonceManager.reset({ address: account.address, chainId: CHAIN.id });
      const clash = /higher priority|underpriced|already known|nonce/i.test(String((err as Error)?.message));
      if (!clash || attempt >= MAX_ATTEMPTS) throw err;
      await new Promise(r => setTimeout(r, 150 + Math.random() * 350 * attempt));
    }
  }
}
