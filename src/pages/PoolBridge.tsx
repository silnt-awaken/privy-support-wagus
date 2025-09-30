import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SendTransactionError,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import { usePrivy } from "@privy-io/react-auth";
import type { ConnectedWallet } from "@privy-io/react-auth";
import {
  useConnectedStandardWallets,
} from "@privy-io/react-auth/solana";
import type {
  ConnectedStandardSolanaWallet,
} from "@privy-io/react-auth/solana";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/useAuth";
import {
  inferSolanaChain,
  describeError,
  type SolanaChainId,
} from "@/lib/solanaTransactionHelper";

const ADMIN_TREASURY_FALLBACK = "5sbiGYrcuQiSCJUfbgWTVPSPccrnDJyBPTyDdw6ZoqJy";
const DEFAULT_TOKEN_DECIMALS = 6;
const ALLOWED_ACTIONS = new Set(["fund_pool", "withdraw_pool"]);
const TREASURY_SETUP_DOC = "https://docs.wagus.com/worlds/treasury-setup";

type BridgeAction = "fund_pool" | "withdraw_pool";

type BridgeStatus =
  | "initializing"
  | "awaiting-auth"
  | "ready"
  | "processing"
  | "success"
  | "failed";

type BridgeParams = {
  action: BridgeAction;
  worldId: string;
  tokenMint: string;
  amount: number;
  amountRaw: string;
  userAddress: string;
  operationId: string;
  poolAddress?: string;
  recipientAddress?: string;
  adminAddress?: string;
  reason?: string;
  returnUrl?: string;
};

type OperationMetadata = {
  worldName?: string;
  poolAddress?: string;
};

type LogLevel = "info" | "warn" | "error" | "success";

type LogEntry = {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  count: number;
  context?: Record<string, unknown>;
  onceKey?: string | null;
};

type AppendLogOptions = {
  level?: LogLevel;
  context?: Record<string, unknown>;
  onceKey?: string;
};

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const MAX_LOG_ENTRIES = 200;
const LOG_LEVEL_META: Record<LogLevel, { label: string; className: string }> = {
  info: {
    label: "INFO",
    className:
      "border border-blue-400/30 bg-blue-500/10 text-blue-100 dark:text-blue-200",
  },
  warn: {
    label: "WARN",
    className:
      "border border-amber-500/40 bg-amber-500/10 text-amber-100 dark:text-amber-200",
  },
  error: {
    label: "ERROR",
    className:
      "border border-red-500/50 bg-red-500/10 text-red-200 dark:text-red-100",
  },
  success: {
    label: "DONE",
    className:
      "border border-green-500/40 bg-green-500/10 text-green-200 dark:text-green-100",
  },
};

function toBaseUnits(
  amountRaw: string,
  decimals: number,
  onWarn?: (message: string) => void,
): bigint {
  const normalized = amountRaw.trim();
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new Error(`Invalid amount "${amountRaw}" provided.`);
  }

  const [wholePart, fractionPart = ""] = normalized.split(".");
  let fractionComponent = fractionPart;

  if (fractionComponent.length > decimals) {
    const truncated = fractionComponent.slice(0, decimals);
    if (onWarn) {
      onWarn(
        `Amount ${amountRaw} has more than ${decimals} decimal places; truncating to ${truncated}.`,
      );
    }
    fractionComponent = truncated;
  }

  const paddedFraction = fractionComponent.padEnd(decimals, "0");
  const digitString = `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, "");

  return BigInt(digitString === "" ? "0" : digitString);
}

function formatSolanaError(error: unknown): string {
  if (error instanceof SendTransactionError) {
    const logs = (error.logs ?? []).filter(Boolean);
    const logSuffix = logs.length > 0 ? ` Logs: ${logs.join(" | ")}` : "";
    return `${error.message}${logSuffix}`;
  }

  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    const maybeCode = (error as { code?: unknown }).code;
    const baseMessage = maybeMessage
      ? String(maybeMessage)
      : JSON.stringify(error);
    return maybeCode
      ? `${baseMessage} (code: ${String(maybeCode)})`
      : baseMessage;
  }

  return String(error);
}

function parseParams(search: string): BridgeParams | null {
  const query = new URLSearchParams(search);
  const action = query.get("action") as BridgeAction | null;
  if (!action || !ALLOWED_ACTIONS.has(action)) return null;

  const worldId = query.get("worldId");
  const tokenMint = query.get("tokenMint");
  const amountStr = query.get("amount");
  const userAddress = query.get("userAddress");
  const operationId = query.get("operationId");

  if (!worldId || !tokenMint || !amountStr || !userAddress || !operationId)
    return null;

  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    action,
    worldId,
    tokenMint,
    amount,
    amountRaw: amountStr,
    userAddress,
    operationId,
    poolAddress: query.get("poolAddress") ?? undefined,
    recipientAddress: query.get("recipientAddress") ?? undefined,
    adminAddress: query.get("adminAddress") ?? undefined,
    reason: query.get("reason") ?? undefined,
    returnUrl: query.get("returnUrl") ?? undefined,
  };
}

function isValidPublicKey(address?: string | null): boolean {
  if (!address) return false;
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export default function PoolBridge() {
  const location = useLocation();
  const params = useMemo(() => parseParams(location.search), [location.search]);
  const { ready, authenticated, login, user, connectOrCreateWallet } = usePrivy();
  const { activeWallet: authActiveWallet, wallets: authWallets, solanaWalletAddress } = useAuth();

  // Use useConnectedStandardWallets hook to get ConnectedStandardSolanaWallet objects with methods
  const { ready: solanaWalletsReady, wallets: privySolanaWallets } = useConnectedStandardWallets();

  const solanaWallets = authWallets ?? [];

  // Track if we've attempted to connect the wallet
  const [walletConnectAttempted, setWalletConnectAttempted] = useState(false);

  const accountMetadataByAddress = useMemo(() => {
    const map = new Map<
      string,
      {
        walletClientType?: string;
        provider?: string;
        embedded?: boolean;
      }
    >();

    user?.linkedAccounts?.forEach((account) => {
      if (account?.type !== "wallet") return;
      const address = (account as { address?: string }).address;
      if (typeof address !== "string" || address.length === 0) return;

      const walletClientType = (
        account as { walletClientType?: string }
      ).walletClientType;
      const normalizedType = walletClientType?.toLowerCase();

      map.set(address, {
        walletClientType,
        provider: (account as { provider?: string }).provider,
        embedded: normalizedType === "privy" || normalizedType === "embedded",
      });
    });

    return map;
  }, [user?.linkedAccounts]);

  const [status, setStatus] = useState<BridgeStatus>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logSequenceRef = useRef(0);
  const formatLogTimestamp = useCallback((iso: string) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString([], { hour12: false });
  }, []);
  const [worldName, setWorldName] = useState<string>("");
  const [poolAddress, setPoolAddress] = useState<string | null>(null);
  const [hasRequestedLogin, setHasRequestedLogin] = useState(false);
  const [needsTreasurySetup, setNeedsTreasurySetup] = useState(false);

  const rpcUrl = import.meta.env.VITE_HELIUS_RPC;
  const isMountedRef = useRef(true);

  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    [],
  );

  const appendLog = useCallback(
    (message: string, options?: AppendLogOptions) => {
      const trimmed = message.trim();
      const level: LogLevel = options?.level ?? "info";
      const timestamp = new Date().toISOString();
      const context = options?.context;
      const onceKey = options?.onceKey ?? null;

      setLogEntries((previous) => {
        const entries = [...previous];

        if (onceKey) {
          const existingIndex = entries.findIndex(
            (entry) => entry.onceKey === onceKey,
          );

          if (existingIndex >= 0) {
            const existing = entries[existingIndex];
            entries[existingIndex] = {
              ...existing,
              message: trimmed,
              timestamp,
              count: existing.count + 1,
              context: context
                ? { ...existing.context, ...context }
                : existing.context,
            };
            return entries;
          }
        }

        const last = entries.length > 0 ? entries[entries.length - 1] : null;
        if (
          !onceKey &&
          last &&
          last.message === trimmed &&
          last.level === level
        ) {
          entries[entries.length - 1] = {
            ...last,
            timestamp,
            count: last.count + 1,
            context: context ? { ...last.context, ...context } : last.context,
          };
          return entries;
        }

        const entry: LogEntry = {
          id: `${Date.now()}-${logSequenceRef.current++}`,
          timestamp,
          level,
          message: trimmed,
          count: 1,
          context,
          onceKey,
        };

        if (entries.length >= MAX_LOG_ENTRIES) {
          entries.shift();
        }

        entries.push(entry);
        return entries;
      });

      const contextString =
        context && Object.keys(context).length > 0
          ? ` ${JSON.stringify(context)}`
          : "";
      const consoleMessage = `[PoolBridge] ${trimmed}${contextString}`;

      if (level === "error") {
        console.error(consoleMessage);
      } else if (level === "warn") {
        console.warn(consoleMessage);
      } else if (level === "success") {
        console.info(consoleMessage);
      } else {
        console.log(consoleMessage);
      }
    },
    [setLogEntries],
  );

  const waitForWalletResponse = useCallback(
    async <T,>(
      operation: () => Promise<T>,
      label: string,
      options?: {
        timeoutMs?: number;
        tickMs?: number;
      },
    ): Promise<T> => {
      const { timeoutMs = 30000, tickMs = 5000 } = options ?? {};
      const startedAt = Date.now();
      let resolved = false;

      const pending = operation();

      return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          appendLog(`${label}: no wallet response – timing out`, {
            level: "error",
            context: {
              elapsedSeconds: elapsed,
              timeoutSeconds: timeoutMs / 1000,
            },
            onceKey: `${label}-wallet-await`,
          });
          reject(new Error(`${label} timed out after ${elapsed} seconds`));
        }, timeoutMs);

        const intervalId = setInterval(() => {
          if (resolved) return;
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          appendLog(`${label}: awaiting wallet signature`, {
            level: "warn",
            context: {
              elapsedSeconds: elapsed,
              timeoutSeconds: timeoutMs / 1000,
            },
            onceKey: `${label}-wallet-await`,
          });
        }, tickMs);

        pending
          .then((value) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);
            clearInterval(intervalId);
            appendLog(`${label}: wallet approved request`, {
              level: "success",
              context: {
                elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
              },
              onceKey: `${label}-wallet-await`,
            });
            resolve(value);
          })
          .catch((error) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);
            clearInterval(intervalId);
            appendLog(`${label}: wallet rejected request`, {
              level: "error",
              context: {
                elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
              },
              onceKey: `${label}-wallet-await`,
            });
            reject(error);
          });
      });
    },
    [appendLog],
  );

  const ensureWalletReady = useCallback(
    async (
      wallet: ConnectedWallet,
      label: string,
    ): Promise<void> => {
      const extended = wallet as unknown as {
        connect?: () => Promise<void>;
        connectedAt?: unknown;
        isConnected?: (() => boolean | Promise<boolean>) | boolean;
        standardWallet?: {
          accounts?: unknown;
          features?: unknown;
        };
      };

      const getFeatureKeys = (features: unknown): string[] => {
        if (!features) return [];
        if (features instanceof Map) {
          return Array.from(features.keys()).map((key) => String(key));
        }
        if (
          typeof features === "object" &&
          typeof (features as { keys?: () => IterableIterator<unknown> })
            .keys === "function" &&
          typeof (features as { get?: () => unknown }).get === "function"
        ) {
          return Array.from(
            (features as { keys: () => IterableIterator<unknown> }).keys(),
          ).map((key) => String(key));
        }
        if (Array.isArray(features)) {
          return features
            .map((entry) => {
              if (typeof entry === "string") return entry;
              if (entry && typeof entry === "object" && "name" in entry) {
                return String((entry as { name: unknown }).name);
              }
              return undefined;
            })
            .filter((value): value is string => Boolean(value));
        }
        if (typeof features === "object") {
          return Object.keys(features as Record<string, unknown>);
        }
        return [];
      };

      const resolveFeature = (
        standardWallet: unknown,
        featureName: string,
      ): unknown => {
        if (!standardWallet || typeof standardWallet !== "object")
          return undefined;
        const features = (standardWallet as { features?: unknown }).features;
        if (!features) return undefined;

        if (features instanceof Map) {
          return features.get(featureName);
        }
        if (
          typeof features === "object" &&
          typeof (features as { get?: (key: string) => unknown }).get ===
            "function"
        ) {
          return (features as { get: (key: string) => unknown }).get(
            featureName,
          );
        }
        if (typeof features === "object") {
          const record = features as Record<string, unknown>;
          if (featureName in record) {
            return record[featureName];
          }
        }
        return undefined;
      };

      const standardWallet = extended.standardWallet;
      if (standardWallet) {
        const featureKeys = getFeatureKeys(
          (standardWallet as { features?: unknown }).features,
        );
        if (featureKeys.length > 0) {
          appendLog(`${label}: standard wallet detected`, {
            context: {
              walletAddress: wallet.address,
              featureKeys,
              accounts: Array.isArray(
                (standardWallet as { accounts?: unknown }).accounts,
              )
                ? (standardWallet as { accounts: unknown[] }).accounts.length
                : undefined,
            },
            onceKey: `${wallet.address}-standard-wallet`,
          });
        }
      }

      const hasStandardAccounts = () => {
        if (!standardWallet) return false;
        const accounts = (standardWallet as { accounts?: unknown }).accounts;
        if (!Array.isArray(accounts)) return false;
        return accounts.length > 0;
      };

      const getConnectFunction = () => {
        const feature = resolveFeature(standardWallet, "standard:connect");
        if (typeof feature === "function") {
          return feature as () => Promise<unknown>;
        }
        if (
          feature &&
          typeof feature === "object" &&
          typeof (feature as { connect?: unknown }).connect === "function"
        ) {
          return (feature as { connect: () => Promise<unknown> }).connect;
        }
        return undefined;
      };

      const describeError = (error: unknown) =>
        error instanceof Error ? error.message : String(error);

      const hasConnectedTimestamp = () => {
        const connectedAt = extended.connectedAt;
        if (connectedAt instanceof Date) {
          return Number.isFinite(connectedAt.getTime());
        }
        return typeof connectedAt === "string" && connectedAt.length > 0;
      };

      const checkIsConnected = async (phase: "pre" | "post") => {
        if (typeof extended.isConnected === "function") {
          try {
            const result = await extended.isConnected();
            appendLog(`${label}: embedded wallet isConnected (${phase})`, {
              context: {
                walletAddress: wallet.address,
                result,
                hasConnectedTimestamp: hasConnectedTimestamp(),
              },
              onceKey: `${wallet.address}-embedded-isConnected-${phase}`,
            });
            return result === true;
          } catch (checkError) {
            appendLog(`${label}: embedded wallet isConnected check failed`, {
              level: "warn",
              context: {
                reason: describeError(checkError),
                walletAddress: wallet.address,
                phase,
              },
            });
            return false;
          }
        }
        if (typeof extended.isConnected === "boolean") {
          const result = extended.isConnected;
          appendLog(`${label}: embedded wallet isConnected (${phase})`, {
            context: {
              walletAddress: wallet.address,
              result,
              hasConnectedTimestamp: hasConnectedTimestamp(),
            },
            onceKey: `${wallet.address}-embedded-isConnected-${phase}`,
          });
          return result;
        }
        return false;
      };

      const alreadyConnectedByTimestamp = hasConnectedTimestamp();
      const alreadyConnectedByProbe = await checkIsConnected("pre");
      const alreadyConnectedByAccounts = hasStandardAccounts();

      const standardConnect = getConnectFunction();
      if (standardConnect) {
        // Check if wallet is already connected
        const isAlreadyConnected = alreadyConnectedByProbe || alreadyConnectedByAccounts || alreadyConnectedByTimestamp;

        if (isAlreadyConnected) {
          appendLog(`${label}: wallet already connected, skipping standard:connect`, {
            context: {
              walletAddress: wallet.address,
              hasConnectedTimestamp: alreadyConnectedByTimestamp,
              standardAccounts: alreadyConnectedByAccounts,
              byProbe: alreadyConnectedByProbe,
            },
            onceKey: `${wallet.address}-embedded-connected`,
          });
          // Skip the connect call entirely if already connected
          return;
        }

        appendLog(`${label}: invoking standard:connect`, {
          context: {
            walletAddress: wallet.address,
          },
          onceKey: `${wallet.address}-standard-connect`,
        });

        try {
          await waitForWalletResponse(
            () => standardConnect(),
            `${label}: standard connect`,
            { timeoutMs: 60000, tickMs: 5000 },
          );
        } catch (connectError) {
          appendLog(`${label}: standard connect failed`, {
            level: "warn",
            context: {
              walletAddress: wallet.address,
              reason: describeError(connectError),
            },
          });
        }

        const connectedAfterConnect =
          hasStandardAccounts() || (await checkIsConnected("post"));
        if (!connectedAfterConnect) {
          appendLog(
            `${label}: wallet still disconnected after standard connect`,
            {
              level: "warn",
              context: { walletAddress: wallet.address },
              onceKey: `${wallet.address}-embedded-still-disconnected`,
            },
          );
        }
        return;
      }

      if (alreadyConnectedByProbe || alreadyConnectedByAccounts) {
        appendLog(`${label}: wallet already connected`, {
          context: {
            walletAddress: wallet.address,
            hasConnectedTimestamp: alreadyConnectedByTimestamp,
            standardAccounts: alreadyConnectedByAccounts,
          },
          onceKey: `${wallet.address}-embedded-connected`,
        });
        return;
      }

      if (alreadyConnectedByTimestamp) {
        appendLog(`${label}: wallet recently connected (timestamp only)`, {
          context: { walletAddress: wallet.address },
          onceKey: `${wallet.address}-embedded-connected-timestamp`,
        });
        return;
      }

      if (typeof extended.connect !== "function") {
        appendLog(`${label}: wallet does not expose a connect helper`, {
          level: "info",
          context: { walletAddress: wallet.address },
          onceKey: `${wallet.address}-embedded-connect-missing`,
        });
        return;
      }

      appendLog(`${label}: requesting embedded wallet connection`, {
        context: {
          walletAddress: wallet.address,
          hadTimestamp: alreadyConnectedByTimestamp,
          probeConnected: alreadyConnectedByProbe,
        },
      });
      await waitForWalletResponse(
        () => extended.connect!(),
        `${label}: connect embedded wallet`,
        { timeoutMs: 60000, tickMs: 5000 },
      );

      const connectedAfterConnect =
        hasConnectedTimestamp() || (await checkIsConnected("post"));
      if (!connectedAfterConnect) {
        appendLog(`${label}: embedded wallet still reports disconnected`, {
          level: "warn",
          context: { walletAddress: wallet.address },
          onceKey: `${wallet.address}-embedded-still-disconnected`,
        });
      }
    },
    [appendLog, waitForWalletResponse],
  );

  const findWalletForAddresses = useCallback(
    (
      preferred: (string | undefined | null)[],
    ): ConnectedWallet | null => {
      for (const candidate of preferred) {
        if (!candidate) continue;
        const wallet = solanaWallets.find(
          (entry) => entry.address === candidate,
        );
        if (wallet) return wallet;
      }

      const embeddedWallet = solanaWallets.find((entry) => {
        const metadata = accountMetadataByAddress.get(entry.address);
        return metadata?.embedded === true;
      });

      if (embeddedWallet) {
        appendLog("Using embedded wallet for signing", {
          context: { walletAddress: embeddedWallet.address },
          onceKey: `${embeddedWallet.address}-embedded-selected`,
        });
        return embeddedWallet as any;
      }

      if (authActiveWallet) return authActiveWallet as any;
      return (solanaWallets[0] as any) ?? null;
    },
    [
      accountMetadataByAddress,
      appendLog,
      authActiveWallet,
      solanaWallets,
    ],
  );

  const markOperation = useCallback(
    async (operationId: string, updates: Record<string, unknown>) => {
      try {
        await updateDoc(doc(db, "bridge_operations", operationId), {
          ...updates,
          updatedAt: serverTimestamp(),
        });
      } catch (updateError) {
        appendLog(`Failed to update bridge operation`, {
          level: "warn",
          context: { operationId, reason: String(updateError) },
        });
      }
    },
    [appendLog],
  );

  const fetchTokenDecimals = useCallback(
    async (connection: Connection, mint: PublicKey, programId: PublicKey) => {
      try {
        const mintInfo = await getMint(connection, mint, undefined, programId);
        const decimals = mintInfo.decimals ?? DEFAULT_TOKEN_DECIMALS;
        if (decimals !== DEFAULT_TOKEN_DECIMALS) {
          appendLog(`Detected token decimals`, {
            context: { decimals },
          });
        }
        return decimals;
      } catch (error) {
        const message = error instanceof Error ? ` (${error.message})` : "";
        appendLog(
          `Failed to fetch token metadata; defaulting to ${DEFAULT_TOKEN_DECIMALS} decimals${message}.`,
          {
            level: "warn",
            context: { mint: mint.toBase58(), programId: programId.toBase58() },
          },
        );
        return DEFAULT_TOKEN_DECIMALS;
      }
    },
    [appendLog],
  );

  const loadOperationMetadata = useCallback(
    async (operationId: string): Promise<OperationMetadata> => {
      try {
        const snapshot = await getDoc(
          doc(db, "bridge_operations", operationId),
        );
        if (!snapshot.exists()) {
          appendLog(`Bridge operation not found`, {
            level: "warn",
            context: { operationId },
          });
          return {};
        }

        const data = snapshot.data();
        const metadata = (data?.data as OperationMetadata | undefined) ?? {};
        if (metadata.worldName) setWorldName(metadata.worldName);
        if (metadata.poolAddress && isValidPublicKey(metadata.poolAddress)) {
          setPoolAddress(metadata.poolAddress);
        }
        return metadata;
      } catch (operationError) {
        appendLog(`Failed to load bridge operation metadata`, {
          level: "warn",
          context: { operationId, reason: String(operationError) },
        });
        return {};
      }
    },
    [appendLog],
  );

  const resolveWorldDetails = useCallback(
    async (
      worldId: string,
      tokenMint: string,
      userAddress?: string,
    ): Promise<void> => {
      const candidateAddresses: string[] = [];
      setNeedsTreasurySetup(false);

      const worldDocRef = doc(db, "worlds", worldId);
      const worldSnapshot = await getDoc(worldDocRef);
      if (worldSnapshot.exists()) {
        const data = worldSnapshot.data();
        if (data?.name) setWorldName(String(data.name));
        [
          data?.poolAddress,
          data?.treasuryAddress,
          data?.metadata?.poolAddress,
          data?.metadata?.poolWalletAddress,
          data?.metadata?.treasuryAddress,
        ].forEach((value) => {
          if (typeof value === "string") candidateAddresses.push(value);
        });
      }

      const poolDocRef = doc(
        db,
        "world_money_pools",
        `${worldId}_${tokenMint}`,
      );
      const poolSnapshot = await getDoc(poolDocRef);
      if (poolSnapshot.exists()) {
        const poolData = poolSnapshot.data();
        const poolMeta = poolData?.metadata;
        if (poolMeta) {
          [
            poolMeta.treasuryAddress,
            poolMeta.poolAddress,
            poolMeta.poolWalletAddress,
          ].forEach((value) => {
            if (typeof value === "string") candidateAddresses.push(value);
          });
        }
      }

      const seen = new Set<string>();
      const normalizedCandidates = candidateAddresses
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => {
          if (!value || value === "system") return false;
          if (seen.has(value)) return false;
          seen.add(value);
          return isValidPublicKey(value) && value !== userAddress;
        });

      const validAddress = normalizedCandidates[0];
      if (validAddress) {
        setPoolAddress(validAddress);
        appendLog(`Resolved pool address`, {
          context: { worldId, tokenMint, address: validAddress },
        });
        return;
      }

      if (worldId === "earth") {
        setPoolAddress(ADMIN_TREASURY_FALLBACK);
        appendLog("Using earth treasury fallback address", {
          level: "warn",
        });
        return;
      }

      setNeedsTreasurySetup(true);
      appendLog("Unable to resolve pool address from Firestore", {
        level: "warn",
        context: { worldId, tokenMint },
      });
    },
    [appendLog],
  );

  useEffect(() => {
    if (!params) {
      setStatus("failed");
      setError("Invalid funding request. Please relaunch from the WAGUS app.");
      return;
    }

    setStatus("awaiting-auth");

    (async () => {
      await loadOperationMetadata(params.operationId);
      await resolveWorldDetails(
        params.worldId,
        params.tokenMint,
        params.userAddress,
      );
    })();
  }, [loadOperationMetadata, params, resolveWorldDetails]);

  useEffect(() => {
    if (
      params?.poolAddress &&
      isValidPublicKey(params.poolAddress) &&
      params.poolAddress !== params.userAddress
    ) {
      setPoolAddress(params.poolAddress.trim());
    }
  }, [params?.poolAddress, params?.userAddress]);

  useEffect(() => {
    if (!params) return;

    if (!ready) {
      setStatus("initializing");
      return;
    }

    if (!authenticated) {
      setStatus("awaiting-auth");
      if (!hasRequestedLogin) {
        appendLog("Requesting Privy login…", {
          context: { provider: "Privy" },
        });
        setHasRequestedLogin(true);
        void (async () => {
          try {
            await login();
          } catch (loginError) {
            appendLog("Login prompt failed", {
              level: "warn",
              context: { reason: String(loginError) },
            });
          }
        })();
      }
      return;
    }

    if (solanaWallets.length === 0) {
      setStatus("initializing");
      appendLog(
        "No Solana wallet found. Please enable Solana embedded wallets in your Privy Dashboard (dashboard.privy.io)",
        {
          level: "error",
          context: {
            authenticated,
            walletsCount: authWallets?.length || 0,
            hint: "Go to dashboard.privy.io → Your App → Embedded Wallets → Enable Solana",
          },
        },
      );
      setError(
        "Solana embedded wallets are not enabled. Please configure this in your Privy Dashboard.",
      );
      return;
    }

    setStatus("ready");
  }, [
    appendLog,
    authenticated,
    hasRequestedLogin,
    login,
    params,
    ready,
    solanaWallets.length,
  ]);

  // Attempt to connect/create Solana wallet when authenticated
  useEffect(() => {
    if (!authenticated || !ready || walletConnectAttempted) return;
    if (privySolanaWallets.length > 0) {
      // Log successful wallet connection
      appendLog(`Solana wallets connected: ${privySolanaWallets.length}`, {
        level: 'success',
        context: {
          solanaWalletsReady,
          walletsCount: privySolanaWallets.length,
          walletAddresses: privySolanaWallets.map(w => w.address),
        },
        onceKey: 'wallet-connection-success',
      });
      return;
    }

    // Try to create/connect Solana wallet
    (async () => {
      try {
        appendLog("Connecting Solana wallet via Privy", {});
        connectOrCreateWallet();
        setWalletConnectAttempted(true);
        appendLog("Solana wallet connected via Privy", { level: 'success' });
      } catch (err) {
        appendLog("Failed to connect Solana wallet", {
          level: 'warn',
          context: { error: String(err) },
        });
        setWalletConnectAttempted(true);
      }
    })();
  }, [authenticated, ready, privySolanaWallets.length, walletConnectAttempted, connectOrCreateWallet, appendLog, solanaWalletsReady, privySolanaWallets]);

  const executeFunding = useCallback(async () => {
    if (!params) return;

    if (!rpcUrl) {
      setError("Missing RPC configuration. Please contact support.");
      setStatus("failed");
      appendLog(
        "VITE_HELIUS_RPC environment variable is not set – cannot submit funding transaction.",
        {
          level: "error",
        },
      );
      return;
    }

    const wallet = findWalletForAddresses([params.userAddress]);

    if (!wallet) {
      setError(
        "No Solana wallet available. Please reconnect in the WAGUS app.",
      );
      setStatus("failed");
      return;
    }

    if (!isValidPublicKey(wallet.address)) {
      setError("Wallet address is invalid.");
      setStatus("failed");
      return;
    }

    const walletMetadata = accountMetadataByAddress.get(wallet.address);
    appendLog("Wallet metadata", {
      context: {
        walletAddress: wallet.address,
        walletClientType: walletMetadata?.walletClientType ?? "unknown",
        provider: walletMetadata?.provider,
        embedded: walletMetadata?.embedded ?? false,
        exposesStandardWallet: Boolean(
          (wallet as unknown as { standardWallet?: unknown }).standardWallet,
        ),
        propertyKeys: Object.keys(wallet as unknown as Record<string, unknown>),
      },
      onceKey: `${wallet.address}-metadata`,
    });

    appendLog("Resolved admin wallet", {
      context: {
        walletAddress: wallet.address,
      },
    });

    appendLog("Resolved contributor wallet", {
      context: {
        walletAddress: wallet.address,
      },
    });

    let targetAddress = poolAddress;
    if (
      !targetAddress &&
      params.poolAddress &&
      isValidPublicKey(params.poolAddress) &&
      params.poolAddress !== params.userAddress
    ) {
      targetAddress = params.poolAddress.trim();
      setPoolAddress(targetAddress);
    }

    if (!targetAddress) {
      setError(
        "Pool destination address is not configured. Please contact support.",
      );
      setStatus("failed");
      appendLog("Pool destination address missing", {
        level: "error",
        context: {
          worldId: params.worldId,
          tokenMint: params.tokenMint,
          userAddress: wallet.address,
        },
      });
      return;
    }

    const connection = new Connection(rpcUrl, "confirmed");
    const chain = inferSolanaChain(rpcUrl);
    setStatus("processing");
    appendLog("Starting funding flow", {
      context: {
        walletAddress: wallet.address,
        poolAddress: targetAddress,
        amount: params.amount,
        tokenMint: params.tokenMint,
        worldId: params.worldId,
        operationId: params.operationId,
      },
    });
    setNeedsTreasurySetup(false);

    await markOperation(params.operationId, {
      status: "processing",
      processingBy: "wagus_web",
      processingAt: serverTimestamp(),
    });

    try {
      const contributor = new PublicKey(wallet.address);
      const poolTreasury = new PublicKey(targetAddress);
      const mint = new PublicKey(params.tokenMint);

      const mintAccountInfo = await connection.getAccountInfo(mint);
      if (!mintAccountInfo) {
        throw new Error("Token mint account not found on Solana.");
      }

      const tokenProgramId = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

      appendLog(
        tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
          ? "Detected Token-2022 mint"
          : "Detected classic SPL token mint",
        {
          context: {
            mint: params.tokenMint,
            programId: tokenProgramId.toBase58(),
          },
        },
      );

      const decimals = await fetchTokenDecimals(
        connection,
        mint,
        tokenProgramId,
      );
      const amountBaseUnits = toBaseUnits(
        params.amountRaw,
        decimals,
        (warning) =>
          appendLog(warning, {
            level: "warn",
            context: {
              tokenMint: params.tokenMint,
              worldId: params.worldId,
            },
          }),
      );
      appendLog(
        `Preparing to transfer ${params.amount} tokens (${amountBaseUnits.toString()} base units)`,
        {
          context: {
            amount: params.amount,
            amountBaseUnits: amountBaseUnits.toString(),
            tokenMint: params.tokenMint,
          },
        },
      );

      const contributorAta = await getAssociatedTokenAddress(
        mint,
        contributor,
        false,
        tokenProgramId,
      );
      const poolAta = await getAssociatedTokenAddress(
        mint,
        poolTreasury,
        true,
        tokenProgramId,
      );

      appendLog("Contributor ATA resolved", {
        context: { address: contributorAta.toBase58() },
      });
      appendLog("Pool ATA resolved", {
        context: { address: poolAta.toBase58() },
      });

      const contributorInfo = await connection.getAccountInfo(contributorAta);
      if (!contributorInfo) {
        throw new Error(
          "Associated token account for contributor not found. Please ensure your wallet holds this token.",
        );
      }
      if (!contributorInfo.owner.equals(tokenProgramId)) {
        throw new Error(
          "Contributor token account is not owned by the expected token program.",
        );
      }

      const destinationInfo = await connection.getAccountInfo(poolAta);
      if (destinationInfo && !destinationInfo.owner.equals(tokenProgramId)) {
        throw new Error(
          "Destination account exists but is not an SPL token account.",
        );
      }

      const sendInstructions = async (
        instructions: TransactionInstruction[],
        label: string,
        onTimeoutCheck?: () => Promise<boolean>,
      ): Promise<string> => {
        const transaction = new Transaction();
        instructions.forEach((instruction) => transaction.add(instruction));
        transaction.feePayer = contributor;
        const latestBlockhash = await connection.getLatestBlockhash();
        transaction.recentBlockhash = latestBlockhash.blockhash;

        appendLog(`${label}: requesting Privy signature`, {
          context: {
            instructionCount: instructions.length,
            walletAddress: wallet.address,
            chain,
          },
        });

        // Verify wallet exists in connected wallets
        const standardWallet = privySolanaWallets.find((w) => w.address === wallet.address);

        if (!standardWallet) {
          throw new Error(`Could not find Privy Solana wallet for address ${wallet.address}. Found ${privySolanaWallets.length} wallets.`);
        }

        appendLog(`${label}: found wallet in connected wallets`, {
          context: {
            address: standardWallet.address,
            walletName: standardWallet.standardWallet?.name,
          },
        });

        let signature: string;
        try {
          appendLog(`${label}: signing and sending transaction`, {
            context: { walletAddress: wallet.address },
          });

          // Serialize transaction as required by Privy API
          const serializedTransaction = transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          });

          // Sign and send directly using Privy's signAndSendTransaction
          const result = await waitForWalletResponse(
            () => (standardWallet as any).signAndSendTransaction({
              chain: chain,
              transaction: serializedTransaction,
            }),
            `${label}: sendTransaction`,
            { timeoutMs: 180000 }
          ) as { signature: string };

          signature = result.signature;

          appendLog(`${label}: transaction sent`, {
            level: 'success',
            context: { signature },
          });
        } catch (sendError) {
          console.error(sendError);
          const message = formatSolanaError(sendError);
          const described = describeError(sendError);
          appendLog(`${label}: sendTransaction failed`, {
            level: "error",
            context: { reason: message, ...described },
          });
          if (
            onTimeoutCheck &&
            sendError instanceof Error &&
            /timed out after/i.test(sendError.message)
          ) {
            try {
              const shouldContinue = await onTimeoutCheck();
              if (shouldContinue) {
                appendLog(
                  `${label}: proceeding after timeout (state verified on-chain)`,
                  {
                    level: "warn",
                  },
                );
                return "timed-out";
              }
            } catch (timeoutCheckError) {
              console.error(timeoutCheckError);
              appendLog(`${label}: timeout recovery check failed`, {
                level: "warn",
                context: { reason: String(timeoutCheckError) },
              });
            }
          }
          throw new Error(message);
        }

        appendLog(`${label}: signature`, {
          level: "success",
          context: { signature },
        });

        try {
          const confirmation = await connection.confirmTransaction(
            {
              signature,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            "confirmed",
          );

          if (confirmation.value.err) {
            const errDetails = JSON.stringify(confirmation.value.err);
            appendLog(`${label}: transaction returned error`, {
              level: "error",
              context: { details: errDetails },
            });
            throw new Error(`Transaction failed: ${errDetails}`);
          }

          appendLog(`${label}: confirmed`, {
            level: "success",
            context: { slot: confirmation.context.slot },
          });
        } catch (confirmError) {
          console.error(confirmError);
          const message = formatSolanaError(confirmError);
          const described = describeError(confirmError);
          appendLog(`${label}: confirmation failed`, {
            level: "error",
            context: { reason: message, ...described },
          });
          throw new Error(message);
        }

        return signature;
      };

      if (!destinationInfo) {
        appendLog(
          "Destination ATA missing – creating associated token account",
          {
            level: "warn",
            context: {
              poolAta: poolAta.toBase58(),
              poolTreasury: poolTreasury.toBase58(),
            },
          },
        );
        await sendInstructions(
          [
            createAssociatedTokenAccountIdempotentInstruction(
              contributor,
              poolAta,
              poolTreasury,
              mint,
              tokenProgramId,
            ),
          ],
          "Create pool ATA",
          async () => {
            const refreshed = await connection.getAccountInfo(poolAta);
            if (refreshed) {
              appendLog(
                "Create pool ATA: associated account detected after timeout",
                {
                  level: "success",
                  context: { poolAta: poolAta.toBase58() },
                  onceKey: "create-pool-ata-timeout",
                },
              );
              return true;
            }
            appendLog(
              "Create pool ATA: associated account still missing after timeout",
              {
                level: "warn",
                context: { poolAta: poolAta.toBase58() },
                onceKey: "create-pool-ata-timeout",
              },
            );
            return false;
          },
        );
      }

      const transferInstruction =
        await createTransferCheckedWithTransferHookInstruction(
          connection,
          contributorAta,
          mint,
          poolAta,
          contributor,
          amountBaseUnits,
          decimals,
          [],
          undefined,
          tokenProgramId,
        );

      const transferSignature = await sendInstructions(
        [transferInstruction],
        "Transfer to pool",
      );

      await markOperation(params.operationId, {
        status: "completed",
        completedAt: serverTimestamp(),
        processedBy: "wagus_web",
        transactionHash: transferSignature,
        result: {
          worldId: params.worldId,
          tokenMint: params.tokenMint,
          amount: params.amount,
          destination: targetAddress,
          contributor: wallet.address,
          method: "privy_wallet_sendTransaction",
          tokenProgramId: tokenProgramId.toBase58(),
        },
      });

      if (!isMountedRef.current) return;

      setStatus("success");
      setNeedsTreasurySetup(false);
      if (params.returnUrl) {
        appendLog("Redirecting back to app", {
          context: { returnUrl: params.returnUrl },
        });
        window.location.href = params.returnUrl;
      }
    } catch (fundError) {
      console.error(fundError);
      const errorMessage =
        fundError instanceof Error ? fundError.message : String(fundError);
      const needsTreasurySetup =
        errorMessage.includes("Create pool ATA timed out") ||
        errorMessage.includes("associated account still missing");

      if (needsTreasurySetup && params.action === "fund_pool") {
        appendLog(
          "Funding blocked because the pool treasury token account does not exist.",
          {
            level: "warn",
            context: { worldId: params.worldId, tokenMint: params.tokenMint },
          },
        );
        appendLog(
          "Ask the world owner to open WAGUS and initialize the treasury before retrying.",
          {
            level: "warn",
            context: { worldId: params.worldId },
          },
        );
        setError(
          "The pool treasury wallet is not ready for WAGUS yet. " +
            "Please have the world owner open the WAGUS app and run treasury setup before retrying.",
        );
        setNeedsTreasurySetup(true);
      } else {
        appendLog(`Funding failed`, {
          level: "error",
          context: { reason: errorMessage },
        });
        setError(errorMessage);
        setNeedsTreasurySetup(false);
      }

      setStatus("failed");

      await markOperation(params.operationId, {
        status: needsTreasurySetup ? "needs_treasury_setup" : "failed",
        completedAt: serverTimestamp(),
        processedBy: "wagus_web",
        error: errorMessage,
      });
    }
  }, [
    accountMetadataByAddress,
    appendLog,
    fetchTokenDecimals,
    findWalletForAddresses,
    markOperation,
    params,
    poolAddress,
    rpcUrl,
    ensureWalletReady,
  ]);

  const executeWithdrawal = useCallback(async () => {
    if (!params) return;

    if (!rpcUrl) {
      setError("Missing RPC configuration. Please contact support.");
      setStatus("failed");
      appendLog(
        "VITE_HELIUS_RPC environment variable is not set – cannot submit withdrawal transaction.",
        {
          level: "error",
        },
      );
      return;
    }

    const wallet = findWalletForAddresses([
      params.adminAddress,
      params.userAddress,
    ]);

    if (!wallet) {
      setError(
        "No Solana wallet available. Please reconnect in the WAGUS app.",
      );
      setStatus("failed");
      return;
    }

    if (!isValidPublicKey(wallet.address)) {
      setError("Wallet address is invalid.");
      setStatus("failed");
      return;
    }

    if (params.adminAddress && wallet.address !== params.adminAddress) {
      appendLog(
        "Admin wallet mismatch. Using connected wallet instead of requested admin wallet.",
        {
          level: "warn",
          context: {
            connectedWallet: wallet.address,
            requestedAdminWallet: params.adminAddress,
          },
        },
      );
    }

    if (
      !params.recipientAddress ||
      !isValidPublicKey(params.recipientAddress)
    ) {
      setError("Recipient address is invalid.");
      setStatus("failed");
      appendLog("Recipient address missing or invalid.", {
        level: "error",
        context: { recipientAddress: params.recipientAddress },
      });
      return;
    }

    let sourceAddress = poolAddress;
    if (
      !sourceAddress &&
      params.poolAddress &&
      isValidPublicKey(params.poolAddress) &&
      params.poolAddress !== params.userAddress
    ) {
      sourceAddress = params.poolAddress.trim();
      setPoolAddress(sourceAddress);
    }

    if (!sourceAddress) {
      appendLog(
        "Pool treasury not provided; using admin wallet as the signing authority.",
        {
          level: "warn",
          context: { adminWallet: wallet.address },
        },
      );
    }

    const connection = new Connection(rpcUrl, "confirmed");
    const chain = inferSolanaChain(rpcUrl);
    setStatus("processing");
    appendLog("Starting withdrawal flow", {
      context: {
        walletAddress: wallet.address,
        poolAddress: sourceAddress ?? params.poolAddress,
        amount: params.amount,
        tokenMint: params.tokenMint,
        worldId: params.worldId,
        operationId: params.operationId,
        recipient: params.recipientAddress,
      },
    });
    setNeedsTreasurySetup(false);

    await markOperation(params.operationId, {
      status: "processing",
      processingBy: "wagus_web",
      processingAt: serverTimestamp(),
    });

    try {
      const admin = new PublicKey(wallet.address);
      const recipient = new PublicKey(params.recipientAddress);
      const mint = new PublicKey(params.tokenMint);

      const mintAccountInfo = await connection.getAccountInfo(mint);
      if (!mintAccountInfo) {
        throw new Error("Token mint account not found on Solana.");
      }

      const tokenProgramId = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

      appendLog(
        tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
          ? "Detected Token-2022 mint"
          : "Detected classic SPL token mint",
        {
          context: {
            mint: params.tokenMint,
            programId: tokenProgramId.toBase58(),
          },
        },
      );

      const decimals = await fetchTokenDecimals(
        connection,
        mint,
        tokenProgramId,
      );
      const amountBaseUnits = toBaseUnits(
        params.amountRaw,
        decimals,
        (warning) =>
          appendLog(warning, {
            level: "warn",
            context: {
              tokenMint: params.tokenMint,
              worldId: params.worldId,
              recipient: params.recipientAddress,
            },
          }),
      );
      appendLog(
        `Preparing to transfer ${params.amount} tokens (${amountBaseUnits.toString()} base units)`,
        {
          context: {
            amount: params.amount,
            amountBaseUnits: amountBaseUnits.toString(),
            tokenMint: params.tokenMint,
          },
        },
      );

      const adminAta = await getAssociatedTokenAddress(
        mint,
        admin,
        false,
        tokenProgramId,
      );
      const recipientAta = await getAssociatedTokenAddress(
        mint,
        recipient,
        true,
        tokenProgramId,
      );

      appendLog("Admin ATA resolved", {
        context: { address: adminAta.toBase58() },
      });
      appendLog("Recipient ATA resolved", {
        context: { address: recipientAta.toBase58() },
      });

      const adminAtaInfo = await connection.getAccountInfo(adminAta);
      if (!adminAtaInfo) {
        throw new Error(
          "Admin wallet has no associated token account for this mint.",
        );
      }
      if (!adminAtaInfo.owner.equals(tokenProgramId)) {
        throw new Error(
          "Admin token account is not owned by the expected token program.",
        );
      }

      const recipientInfo = await connection.getAccountInfo(recipientAta);

      const sendInstructions = async (
        instructions: TransactionInstruction[],
        label: string,
        onTimeoutCheck?: () => Promise<boolean>,
      ): Promise<string> => {
        const transaction = new Transaction();
        instructions.forEach((instruction) => transaction.add(instruction));
        transaction.feePayer = admin;
        const latestBlockhash = await connection.getLatestBlockhash();
        transaction.recentBlockhash = latestBlockhash.blockhash;

        appendLog(`${label}: requesting Privy signature`, {
          context: {
            instructionCount: instructions.length,
            walletAddress: wallet.address,
            chain,
          },
        });

        // Verify wallet exists in connected wallets
        const standardWallet = privySolanaWallets.find((w) => w.address === wallet.address);

        if (!standardWallet) {
          throw new Error(`Could not find Privy Solana wallet for address ${wallet.address}. Found ${privySolanaWallets.length} wallets.`);
        }

        appendLog(`${label}: found wallet in connected wallets`, {
          context: {
            address: standardWallet.address,
            walletName: standardWallet.standardWallet?.name,
          },
        });

        let signature: string;
        try {
          appendLog(`${label}: signing and sending transaction`, {
            context: { walletAddress: wallet.address },
          });

          // Serialize transaction as required by Privy API
          const serializedTransaction = transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          });

          // Sign and send directly using Privy's signAndSendTransaction
          const result = await waitForWalletResponse(
            () => (standardWallet as any).signAndSendTransaction({
              chain: chain,
              transaction: serializedTransaction,
            }),
            `${label}: sendTransaction`,
            { timeoutMs: 180000 }
          ) as { signature: string };

          signature = result.signature;

          appendLog(`${label}: transaction sent`, {
            level: 'success',
            context: { signature },
          });
        } catch (sendError) {
          console.error(sendError);
          const message = formatSolanaError(sendError);
          appendLog(`${label}: sendTransaction failed`, {
            level: "error",
            context: { reason: message },
          });

          if (
            onTimeoutCheck &&
            sendError instanceof Error &&
            /timed out after/i.test(sendError.message)
          ) {
            try {
              const shouldContinue = await onTimeoutCheck();
              if (shouldContinue) {
                appendLog(
                  `${label}: proceeding after timeout (state verified on-chain)`,
                  {
                    level: "warn",
                  },
                );
                return "timed-out";
              }
            } catch (timeoutCheckError) {
              console.error(timeoutCheckError);
              appendLog(`${label}: timeout recovery check failed`, {
                level: "warn",
                context: { reason: String(timeoutCheckError) },
              });
            }
          }

          throw new Error(message);
        }

        appendLog(`${label}: signature`, {
          level: "success",
          context: { signature },
        });

        try {
          const confirmation = await connection.confirmTransaction(
            {
              signature,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            "confirmed",
          );
          appendLog(`${label}: transaction confirmed`, {
            level: "success",
            context: { status: confirmation.value.err ? "err" : "ok" },
          });
        } catch (confirmationError) {
          appendLog(`${label}: confirmation check failed`, {
            level: "warn",
            context: { reason: String(confirmationError) },
          });
        }

        return signature;
      };

      if (!recipientInfo) {
        appendLog("Recipient ATA missing – creating associated token account", {
          level: "warn",
          context: {
            recipientAta: recipientAta.toBase58(),
            recipient: recipient.toBase58(),
          },
        });
        await sendInstructions(
          [
            createAssociatedTokenAccountIdempotentInstruction(
              admin,
              recipientAta,
              recipient,
              mint,
              tokenProgramId,
            ),
          ],
          "Create recipient ATA",
          async () => {
            const refreshed = await connection.getAccountInfo(recipientAta);
            if (refreshed) {
              appendLog(
                "Create recipient ATA: associated account detected after timeout",
                {
                  level: "success",
                  context: { recipientAta: recipientAta.toBase58() },
                  onceKey: "create-recipient-ata-timeout",
                },
              );
              return true;
            }
            appendLog(
              "Create recipient ATA: associated account still missing after timeout",
              {
                level: "warn",
                context: { recipientAta: recipientAta.toBase58() },
                onceKey: "create-recipient-ata-timeout",
              },
            );
            return false;
          },
        );
      }

      const transferInstruction =
        await createTransferCheckedWithTransferHookInstruction(
          connection,
          adminAta,
          mint,
          recipientAta,
          admin,
          amountBaseUnits,
          decimals,
          [],
          undefined,
          tokenProgramId,
        );

      const signature = await sendInstructions(
        [transferInstruction],
        "Transfer to recipient",
      );

      await markOperation(params.operationId, {
        status: "completed",
        completedAt: serverTimestamp(),
        processedBy: "wagus_web",
        transactionHash: signature,
        result: {
          worldId: params.worldId,
          tokenMint: params.tokenMint,
          amount: params.amount,
          source: wallet.address,
          recipient: params.recipientAddress,
          method: "privy_wallet_sendTransaction",
          tokenProgramId: tokenProgramId.toBase58(),
        },
      });

      if (!isMountedRef.current) return;

      setStatus("success");
      setNeedsTreasurySetup(false);
      if (params.returnUrl) {
        appendLog("Redirecting back to app", {
          context: { returnUrl: params.returnUrl },
        });
        window.location.href = params.returnUrl;
      }
    } catch (withdrawError) {
      console.error(withdrawError);
      const errorMessage =
        withdrawError instanceof Error
          ? withdrawError.message
          : String(withdrawError);
      const needsTreasurySetup =
        errorMessage.includes("Create recipient ATA timed out") ||
        errorMessage.includes("associated account still missing");

      if (needsTreasurySetup) {
        appendLog(
          "Withdrawal blocked because the recipient token account does not exist.",
          {
            level: "warn",
            context: {
              worldId: params.worldId,
              tokenMint: params.tokenMint,
              recipient: params.recipientAddress,
            },
          },
        );
        appendLog(
          "Ask the recipient to create the token account or have the world owner initialize it.",
          {
            level: "warn",
            context: {
              worldId: params.worldId,
              recipient: params.recipientAddress,
            },
          },
        );
        setError(
          "The recipient wallet does not have an account for this token yet. " +
            "Please ensure it exists before retrying.",
        );
        setNeedsTreasurySetup(false);
      } else {
        appendLog("Withdrawal failed", {
          level: "error",
          context: { reason: errorMessage },
        });
        setError(errorMessage);
        setNeedsTreasurySetup(false);
      }
      setStatus("failed");

      await markOperation(params.operationId, {
        status: needsTreasurySetup ? "needs_treasury_setup" : "failed",
        completedAt: serverTimestamp(),
        processedBy: "wagus_web",
        error: errorMessage,
      });
    }
  }, [
    appendLog,
    fetchTokenDecimals,
    findWalletForAddresses,
    markOperation,
    params,
    poolAddress,
    rpcUrl,
    ensureWalletReady,
  ]);

  const triggerAction = useCallback(() => {
    if (!params) return;

    if (params.action === "withdraw_pool") {
      void executeWithdrawal();
    } else {
      void executeFunding();
    }
  }, [executeFunding, executeWithdrawal, params]);

  useEffect(() => {
    if (rpcUrl) return;

    appendLog(
      "VITE_HELIUS_RPC environment variable is missing; unable to connect to Solana.",
      {
        level: "error",
      },
    );
    setStatus("failed");
    setError("Missing RPC configuration. Please contact support.");
  }, [appendLog, rpcUrl]);

  const title = useMemo(() => {
    if (!params) return "Pool Bridge";
    return params.action === "fund_pool" ? "Fund Pool" : "Pool Withdrawal";
  }, [params]);

  const displayPoolAddress = useMemo(() => {
    if (!params) return null;
    if (poolAddress) return poolAddress;
    if (
      params.poolAddress &&
      isValidPublicKey(params.poolAddress) &&
      params.poolAddress !== params.userAddress
    ) {
      return params.poolAddress.trim();
    }
    if (params.worldId === "earth") return ADMIN_TREASURY_FALLBACK;
    return null;
  }, [params, poolAddress]);

  const displayAdminAddress = useMemo(() => {
    if (!params) return null;
    return params.action === "fund_pool"
      ? params.userAddress
      : (params.adminAddress ?? params.userAddress);
  }, [params]);

  const displayRecipientAddress = useMemo(() => {
    if (!params || params.action !== "withdraw_pool") return null;
    return params.recipientAddress ?? null;
  }, [params]);

  if (!params) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="max-w-md p-6 bg-gray-900/80 rounded-xl border border-white/10">
          <h1 className="text-xl font-mono mb-2">Pool Bridge</h1>
          <p className="text-sm text-red-400">
            Missing or invalid parameters. Please relaunch the funding flow from
            the WAGUS app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="bg-gray-900/60 border border-white/10 rounded-2xl p-6 space-y-6">
          <header className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-wide">{title}</h1>
            <p className="text-sm text-gray-400">
              Seamlessly bridge from the WAGUS app to Privy for anonymous
              on-chain settlement.
            </p>
          </header>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <p className="text-gray-500">World</p>
              <p className="font-mono text-lg">{worldName || params.worldId}</p>
            </div>
            <div className="space-y-1">
              <p className="text-gray-500">Amount</p>
              <p className="font-mono text-lg">
                {params.amount.toFixed(2)} tokens
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-gray-500">
                {params.action === "fund_pool" ? "Contributor" : "Admin Wallet"}
              </p>
              <p className="font-mono break-all text-xs md:text-sm">
                {displayAdminAddress ?? "Unknown wallet"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-gray-500">Pool Treasury</p>
              <p className="font-mono break-all text-xs md:text-sm">
                {displayPoolAddress ?? "Resolving..."}
              </p>
            </div>
            {params.action === "withdraw_pool" && (
              <div className="space-y-1">
                <p className="text-gray-500">Recipient</p>
                <p className="font-mono break-all text-xs md:text-sm">
                  {displayRecipientAddress ?? "Missing recipient"}
                </p>
              </div>
            )}
            {params.action === "withdraw_pool" && params.reason && (
              <div className="space-y-1 md:col-span-2">
                <p className="text-gray-500">Reason</p>
                <p className="text-xs md:text-sm text-gray-300">
                  {params.reason}
                </p>
              </div>
            )}
          </section>

          <section className="rounded-xl bg-black/40 border border-white/5 p-4">
            <h2 className="font-mono text-sm text-gray-400 mb-2">
              Diagnostics
            </h2>
            <ul className="space-y-2 max-h-56 overflow-y-auto text-xs">
              {logEntries.length === 0 && (
                <li className="text-gray-500">Waiting for updates…</li>
              )}
              {logEntries.map((entry) => {
                const levelMeta = LOG_LEVEL_META[entry.level];
                const contextPairs = entry.context
                  ? Object.entries(entry.context).filter(
                      ([, value]) => value !== undefined && value !== null,
                    )
                  : [];
                return (
                  <li
                    key={entry.id}
                    className="rounded-lg border border-white/10 bg-gray-950/30 p-2 text-gray-200"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.18em] uppercase ${levelMeta.className}`}
                      >
                        {levelMeta.label}
                      </span>
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2 text-gray-200">
                          <span className="leading-tight">{entry.message}</span>
                          {entry.count > 1 && (
                            <span className="text-[10px] uppercase tracking-wide text-gray-500">
                              ×{entry.count}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                          <span>{formatLogTimestamp(entry.timestamp)}</span>
                          {contextPairs.map(([key, value]) => (
                            <span
                              key={`${entry.id}-${key}`}
                              className="rounded bg-gray-900/70 px-1.5 py-0.5 font-mono text-[10px] text-gray-400"
                            >
                              {key}: {String(value)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="space-y-3">
            {status === "failed" && error && (
              <div className="bg-red-500/10 border border-red-500/40 text-red-300 rounded-lg px-4 py-3 text-sm">
                {error}
              </div>
            )}

            {status === "failed" && needsTreasurySetup && (
              <div className="bg-purple-500/10 border border-purple-500/40 text-purple-200 rounded-lg px-4 py-3 text-xs space-y-2">
                <p>
                  Only the world owner can initialize the treasury for each
                  token. Launch the WAGUS app as the owner and run the treasury
                  setup flow, then retry this contribution.
                </p>
                <p>
                  <a
                    href={TREASURY_SETUP_DOC}
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-purple-300 hover:text-purple-100"
                  >
                    Open the treasury setup guide ↗
                  </a>
                </p>
              </div>
            )}

            {!authenticated && status !== "success" && (
              <button
                type="button"
                className="w-full bg-purple-600 hover:bg-purple-500 transition rounded-lg py-3 font-semibold"
                onClick={() => {
                  void (async () => {
                    try {
                      login();
                    } catch {
                      /* no-op */
                    }
                  })();
                }}
              >
                Sign In with Privy
              </button>
            )}

            {authenticated && status === "ready" && (
              <button
                type="button"
                className="w-full bg-purple-500/20 border border-purple-500/40 hover:bg-purple-500/30 transition rounded-lg py-3 font-semibold"
                onClick={triggerAction}
              >
                {params.action === "fund_pool"
                  ? "Authorize Funding"
                  : "Authorize Withdrawal"}
              </button>
            )}

            {status === "processing" && (
              <div className="flex items-center justify-center space-x-3 text-sm text-gray-400">
                <span className="w-3 h-3 rounded-full bg-purple-400 animate-pulse" />
                <span>
                  Processing{" "}
                  {params.action === "fund_pool"
                    ? "contribution"
                    : "withdrawal"}{" "}
                  with Privy…
                </span>
              </div>
            )}

            {status === "success" && (
              <div className="bg-green-500/10 border border-green-500/40 text-green-300 rounded-lg px-4 py-3 text-sm">
                {params.action === "fund_pool"
                  ? "Pool funded successfully! If the app does not close automatically, you may return manually."
                  : "Withdrawal completed successfully! If the app does not close automatically, you may return manually."}
              </div>
            )}

            <footer className="text-xs text-gray-500 text-center">
              Network: Solana Mainnet • Powered by Privy session signing
              {user?.email?.address && (
                <span className="block mt-1">
                  Signed in as {user.email.address}
                </span>
              )}
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
