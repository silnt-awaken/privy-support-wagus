import type { Connection, Transaction } from "@solana/web3.js";
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import bs58 from "bs58";

// Type alias for compatibility with components
type ConnectedSolanaWallet = ConnectedStandardSolanaWallet;

export type SolanaChainId =
  | "solana:mainnet"
  | "solana:devnet"
  | "solana:testnet";

export const inferSolanaChain = (endpoint?: string | null): SolanaChainId => {
  if (!endpoint) {
    return "solana:mainnet";
  }

  const normalized = endpoint.toLowerCase();
  if (normalized.includes("devnet")) {
    return "solana:devnet";
  }
  if (normalized.includes("testnet")) {
    return "solana:testnet";
  }

  return "solana:mainnet";
};

type AppendLogFn = (
  message: string,
  options?: {
    level?: "info" | "warn" | "error" | "success";
    context?: Record<string, unknown>;
    onceKey?: string;
  },
) => void;

type WaitForWalletResponseFn = <T>(
  operation: () => Promise<T>,
  label: string,
  options?: {
    timeoutMs?: number;
    tickMs?: number;
  },
) => Promise<T>;

const encodeTransactionBytes = (transaction: Transaction): Uint8Array =>
  transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

const safeSerialize = (value: unknown) => {
  if (
    value === null ||
    typeof value === "undefined" ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as string | number | boolean | null | undefined;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => safeSerialize(entry));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return {};
    return Object.fromEntries(
      entries
        .filter(([, v]) => typeof v !== "function")
        .map(([key, v]) => [key, safeSerialize(v)]),
    );
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return String(value);
  }
};

export const describeError = (error: unknown) => {
  const base: Record<string, unknown> = {};

  if (error instanceof Error) {
    base.name = error.name;
    base.message = error.message;
    if (error.stack) {
      base.stack = error.stack;
    }
  }

  if (error && typeof error === "object") {
    const withCode = error as {
      code?: unknown;
      cause?: unknown;
      details?: unknown;
    };
    if (typeof withCode.code !== "undefined") {
      base.code = safeSerialize(withCode.code);
    }
    if (typeof withCode.cause !== "undefined") {
      base.cause = safeSerialize(withCode.cause);
    }
    if (typeof withCode.details !== "undefined") {
      base.details = safeSerialize(withCode.details);
    }
  }

  base.raw = safeSerialize(error);

  return base;
};

type SignAndSendTransactionHook = (args: {
  transaction: Uint8Array;
  wallet: ConnectedSolanaWallet;
  chain: SolanaChainId;
}) => Promise<{ signature: Uint8Array }>;

type SignTransactionHook = (args: {
  transaction: Uint8Array;
  wallet: ConnectedSolanaWallet;
  chain: SolanaChainId;
}) => Promise<{ signedTransaction: Uint8Array }>;

export async function sendTransactionWithFallback({
  wallet,
  transaction,
  connection,
  waitForWalletResponse,
  appendLog,
  ensureWalletReady,
  label,
  chain = "solana:mainnet",
  signAndSendTransactionHook,
  signTransactionHook,
  useDirectEmbeddedSigning = false,
}: {
  wallet: ConnectedSolanaWallet;
  transaction: Transaction;
  connection: Connection;
  waitForWalletResponse: WaitForWalletResponseFn;
  appendLog?: AppendLogFn;
  ensureWalletReady?: (
    wallet: ConnectedSolanaWallet,
    label: string,
  ) => Promise<void>;
  label: string;
  chain?: "solana:mainnet" | "solana:devnet" | "solana:testnet";
  signAndSendTransactionHook?: SignAndSendTransactionHook;
  signTransactionHook?: SignTransactionHook;
  useDirectEmbeddedSigning?: boolean;
}): Promise<string> {
  const log = appendLog ?? (() => {});

  // ALWAYS use direct signing for Privy Solana wallets (they don't support sendTransaction)
  const walletClientType = (wallet as any).walletClientType;
  const isPrivyWallet = walletClientType === 'privy';

  if (useDirectEmbeddedSigning || isPrivyWallet) {
    throw new Error("Direct embedded signing no longer supported - wallet helper removed");
  }

  if (ensureWalletReady) {
    await ensureWalletReady(wallet, label);
  }

  const transactionBytes = encodeTransactionBytes(transaction);

  const sendWithWallet = async () => {
    // In v1.x, sendTransaction returns the signature string directly
    const signature = await waitForWalletResponse(
      () =>
        signAndSendTransactionHook
          ? signAndSendTransactionHook({
              transaction: transactionBytes,
              wallet,
              chain,
            }).then((res) => bs58.encode(res.signature))
          : (wallet as any).sendTransaction(transaction, connection, {
              preflightCommitment: "confirmed",
            }),
      label,
      { timeoutMs: 180000 },
    );

    log(`${label}: wallet sendTransaction succeeded`, {
      level: "success",
      context: { signature },
    });

    return signature;
  };

  const sendWithManualSigning = async () => {
    try {
      // In v1.x, signTransaction returns the signed transaction directly
      const signedTransaction: Transaction = await waitForWalletResponse(
        () =>
          signTransactionHook
            ? signTransactionHook({
                transaction: transactionBytes,
                wallet,
                chain,
              }).then((res) => res.signedTransaction as any as Transaction)
            : (wallet as any).signTransaction(transaction),
        label,
        { timeoutMs: 180000 },
      ) as any;

      const signature = await waitForWalletResponse(
        () =>
          connection.sendRawTransaction(signedTransaction.serialize(), {
            preflightCommitment: "confirmed",
          }),
        label,
        { timeoutMs: 180000 },
      );

      log(`${label}: signed transaction submitted via RPC`, {
        level: "success",
        context: { signature },
      });

      return signature;
    } catch (manualError) {
      log(`${label}: manual signing path failed`, {
        level: "error",
        context: {
          walletAddress: wallet.address,
          ...describeError(manualError),
        },
      });
      throw manualError;
    }
  };

  try {
    return (await sendWithWallet()) as string;
  } catch (error) {
    const reason = describeError(error);
    log(
      `${label}: signAndSendTransaction failed – attempting manual fallback`,
      {
        level: "warn",
        context: {
          walletAddress: wallet.address,
          ...reason,
        },
      },
    );

    return sendWithManualSigning();
  }
}

type ConfirmArgs = {
  blockhash: string;
  lastValidBlockHeight: number;
};

export async function sendAndConfirmTransaction({
  wallet,
  transaction,
  connection,
  waitForWalletResponse,
  appendLog,
  ensureWalletReady,
  label,
  chain,
  latestBlockhash,
  commitment = "confirmed",
  signAndSendTransactionHook,
  signTransactionHook,
}: {
  wallet: ConnectedSolanaWallet;
  transaction: Transaction;
  connection: Connection;
  waitForWalletResponse: WaitForWalletResponseFn;
  appendLog?: AppendLogFn;
  ensureWalletReady?: (
    wallet: ConnectedSolanaWallet,
    label: string,
  ) => Promise<void>;
  label: string;
  chain: SolanaChainId;
  latestBlockhash?: ConfirmArgs;
  commitment?: "processed" | "confirmed" | "finalized";
  signAndSendTransactionHook?: SignAndSendTransactionHook;
  signTransactionHook?: SignTransactionHook;
}): Promise<string> {
  const signature = await sendTransactionWithFallback({
    wallet,
    transaction,
    connection,
    waitForWalletResponse,
    appendLog,
    ensureWalletReady,
    label,
    chain,
    signAndSendTransactionHook,
    signTransactionHook,
  });

  if (latestBlockhash) {
    try {
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        commitment,
      );
    } catch (confirmationError) {
      const log = appendLog ?? (() => {});
      log(`${label}: confirmation check failed`, {
        level: "warn",
        context: { reason: String(confirmationError) },
      });
    }
  }

  return signature;
}