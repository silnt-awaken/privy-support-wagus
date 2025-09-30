import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import { usePrivy } from "@privy-io/react-auth";
import { useConnectedStandardWallets } from "@privy-io/react-auth/solana";
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import { db } from "../lib/firebase";

type BridgeStatus = "initializing" | "awaiting-auth" | "ready" | "processing" | "success" | "failed";

type BridgeParams = {
  action: string;
  worldId: string;
  tokenMint: string;
  amount: number;
  userAddress: string;
  operationId: string;
  poolAddress?: string;
};

function inferSolanaChain(rpcUrl: string): "solana:mainnet" | "solana:devnet" | "solana:testnet" {
  const url = rpcUrl.toLowerCase();
  if (url.includes("devnet")) return "solana:devnet";
  if (url.includes("testnet")) return "solana:testnet";
  return "solana:mainnet";
}

export default function PoolBridge() {
  const location = useLocation();
  const { ready, authenticated, user, login } = usePrivy();
  const { ready: solanaWalletsReady, wallets: privySolanaWallets } = useConnectedStandardWallets();

  const [status, setStatus] = useState<BridgeStatus>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<BridgeParams | null>(null);

  // Parse URL parameters
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const action = searchParams.get("action");
    const worldId = searchParams.get("worldId");
    const tokenMint = searchParams.get("tokenMint");
    const amount = searchParams.get("amount");
    const userAddress = searchParams.get("userAddress");
    const operationId = searchParams.get("operationId");
    const poolAddress = searchParams.get("poolAddress");

    if (!action || !worldId || !tokenMint || !amount || !userAddress || !operationId) {
      setError("Missing required parameters");
      setStatus("failed");
      return;
    }

    setParams({
      action,
      worldId,
      tokenMint,
      amount: parseFloat(amount),
      userAddress,
      operationId,
      poolAddress: poolAddress || undefined,
    });

    setStatus("awaiting-auth");
  }, [location.search]);

  // Check authentication
  useEffect(() => {
    if (!ready || !solanaWalletsReady) return;

    if (status === "awaiting-auth" && authenticated && params) {
      setStatus("ready");
    }
  }, [ready, authenticated, solanaWalletsReady, status, params]);

  const findWalletForAddresses = useCallback(
    (addresses: string[]): ConnectedStandardSolanaWallet | null => {
      for (const addr of addresses) {
        const wallet = privySolanaWallets.find((w) => w.address === addr);
        if (wallet) return wallet;
      }
      return null;
    },
    [privySolanaWallets]
  );

  const executeFunding = useCallback(async () => {
    if (!params) return;

    const wallet = findWalletForAddresses([params.userAddress]);

    if (!wallet) {
      setError("No Solana wallet available");
      setStatus("failed");
      return;
    }

    const rpcUrl = import.meta.env.VITE_HELIUS_RPC;
    const connection = new Connection(rpcUrl, "confirmed");
    const chain = inferSolanaChain(rpcUrl);

    setStatus("processing");
    console.log("Starting funding flow", {
      walletAddress: wallet.address,
      poolAddress: params.poolAddress,
      amount: params.amount,
      tokenMint: params.tokenMint,
    });

    try {
      // Get token mint info
      const mintPublicKey = new PublicKey(params.tokenMint);
      const mintInfo = await getMint(connection, mintPublicKey);
      const tokenProgramId = mintInfo.tlvData.length > 0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const decimals = mintInfo.decimals;
      const amountBaseUnits = BigInt(params.amount * 10 ** decimals);

      // Get ATAs
      const contributorAta = await getAssociatedTokenAddress(
        mintPublicKey,
        new PublicKey(wallet.address),
        false,
        tokenProgramId
      );

      const poolAta = await getAssociatedTokenAddress(
        mintPublicKey,
        new PublicKey(params.poolAddress!),
        false,
        tokenProgramId
      );

      // Create transfer instruction
      const transferInstruction = createTransferCheckedWithTransferHookInstruction(
        contributorAta,
        mintPublicKey,
        poolAta,
        new PublicKey(wallet.address),
        amountBaseUnits,
        decimals,
        [],
        undefined,
        tokenProgramId
      );

      // Send transaction using sendInstructions
      const sendInstructions = async (
        instructions: TransactionInstruction[],
        label: string
      ): Promise<string> => {
        const transaction = new Transaction();
        instructions.forEach((instruction) => transaction.add(instruction));
        transaction.feePayer = new PublicKey(wallet.address);

        const latestBlockhash = await connection.getLatestBlockhash();
        transaction.recentBlockhash = latestBlockhash.blockhash;

        console.log(`${label}: requesting Privy signature`, {
          instructionCount: instructions.length,
          walletAddress: wallet.address,
          chain,
        });

        // Verify wallet exists in connected wallets
        const standardWallet = privySolanaWallets.find((w) => w.address === wallet.address);

        if (!standardWallet) {
          throw new Error(
            `Could not find Privy Solana wallet for address ${wallet.address}. Found ${privySolanaWallets.length} wallets.`
          );
        }

        console.log(`${label}: found wallet in connected wallets`, {
          address: standardWallet.address,
          walletName: standardWallet.standardWallet?.name,
        });

        let signature: string;
        try {
          console.log(`${label}: signing and sending transaction`, {
            walletAddress: wallet.address,
          });

          // Serialize transaction as required by Privy API
          const serializedTransaction = transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          });

          // ❌ THIS IS WHERE THE ERROR OCCURS
          // Error: "User must be authenticated to use their embedded wallet"
          const result = (await (standardWallet as any).signAndSendTransaction({
            chain: chain,
            transaction: serializedTransaction,
          })) as { signature: string };

          signature = result.signature;

          console.log(`${label}: transaction sent`, { signature });
        } catch (sendError) {
          console.error(sendError);
          throw new Error(sendError instanceof Error ? sendError.message : String(sendError));
        }

        return signature;
      };

      const transferSignature = await sendInstructions([transferInstruction], "Transfer to pool");

      // Mark operation as completed in Firebase
      const operationRef = doc(db, "world_pool_operations", params.operationId);
      await updateDoc(operationRef, {
        status: "completed",
        transactionHash: transferSignature,
        completedAt: serverTimestamp(),
      });

      setStatus("success");
    } catch (fundError) {
      console.error(fundError);
      const errorMessage = fundError instanceof Error ? fundError.message : String(fundError);
      console.log("Funding failed:", { reason: errorMessage });
      setError(errorMessage);
      setStatus("failed");
    }
  }, [params, privySolanaWallets, findWalletForAddresses]);

  if (status === "initializing") {
    return <div style={{ padding: "20px" }}>Loading...</div>;
  }

  if (status === "failed") {
    return (
      <div style={{ padding: "20px", color: "red" }}>
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (status === "awaiting-auth") {
    return (
      <div style={{ padding: "20px" }}>
        <h2>Authentication Required</h2>
        <button onClick={login}>Login with Privy</button>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div style={{ padding: "20px", color: "green" }}>
        <h2>Success!</h2>
        <p>Transaction completed successfully</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "20px" }}>
      <h2>Pool Bridge</h2>
      <div>
        <p>
          <strong>Status:</strong> {status}
        </p>
        <p>
          <strong>Authenticated:</strong> {authenticated ? "Yes" : "No"}
        </p>
        <p>
          <strong>Wallets:</strong> {privySolanaWallets.length}
        </p>
        {params && (
          <>
            <p>
              <strong>Action:</strong> {params.action}
            </p>
            <p>
              <strong>Amount:</strong> {params.amount}
            </p>
            <p>
              <strong>Token:</strong> {params.tokenMint}
            </p>
          </>
        )}
      </div>
      {status === "ready" && (
        <button onClick={executeFunding} style={{ marginTop: "20px", padding: "10px 20px" }}>
          Execute Transaction
        </button>
      )}
      {status === "processing" && <p>Processing transaction...</p>}
      {error && (
        <div style={{ marginTop: "20px", color: "red" }}>
          <strong>Error:</strong> {error}
        </div>
      )}
    </div>
  );
}