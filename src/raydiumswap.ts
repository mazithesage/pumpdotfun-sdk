import {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
} from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

type SwapParams = {
  rpcEndpoint: string; // Solana RPC endpoint
  privateKey: string; // Wallet private key in Base58
  inputMint: string; // Input token mint address
  outputMint: string; // Output token mint address
  amountIn: number; // Amount of input token to swap (smallest unit)
  slippage: number; // Slippage tolerance as a percentage
};

/**
 * Bundles tokens and performs a swap on Raydium with robust error handling.
 */
export async function raydiumSwapTokens({
  rpcEndpoint,
  privateKey,
  inputMint,
  outputMint,
  amountIn,
  slippage,
}: SwapParams): Promise<string> {
  // Validate parameters
  if (!rpcEndpoint || !privateKey || !inputMint || !outputMint || amountIn <= 0) {
    throw new Error("Invalid parameters: Ensure all required fields are provided and valid.");
  }
  if (slippage <= 0 || slippage > 100) {
    throw new Error("Invalid slippage: Slippage must be between 0 and 100.");
  }

  try {
    const connection = new Connection(rpcEndpoint, "confirmed");

    // Decode private key and create wallet
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const walletPubkey = wallet.publicKey;

    console.log(`[INFO] Wallet address: ${walletPubkey.toBase58()}`);

    // Load Raydium SDK
    console.log("[INFO] Loading Raydium SDK...");
    const raydium = await Raydium.load({
      connection,
      owner: wallet,
      disableLoadToken: false,
    });
    console.log("[INFO] Raydium SDK loaded successfully.");

    // Fetch pool for the inputMint and outputMint pair
    console.log("[INFO] Fetching pool details...");
    const pool = await raydium.api.fetchPoolByMints({
      mint1: inputMint,
      mint2: outputMint,
    });

    if (!pool) {
      throw new Error("No pool found for the given token pair.");
    }
    console.log("[INFO] Pool details fetched successfully:", pool);

    // Calculate minimum amount out (based on slippage)
    const amountOutMin = Math.floor((1 - slippage / 100) * pool.outputTokenAmount);
    console.log(
      `[INFO] Swapping ${amountIn} ${inputMint} for ${outputMint} with slippage tolerance: ${slippage}%.`
    );
    console.log(`[INFO] Minimum amount out after slippage: ${amountOutMin}`);

    // Build the transaction
    console.log("[INFO] Preparing swap transaction...");
    const { transaction } = await raydium.cpmm.buildSwapTransaction({
      poolInfo: pool,
      amountIn,
      amountOutMin,
      userKeys: { owner: wallet.publicKey },
    });

    // Check transaction validity
    if (!transaction) {
      throw new Error("Failed to build swap transaction.");
    }

    // Send the transaction
    console.log("[INFO] Sending transaction...");
    const signature = await connection.sendTransaction(transaction, [wallet], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    console.log(`[SUCCESS] Transaction sent! Signature: ${signature}`);
    console.log(`[INFO] View on Solscan: https://solscan.io/tx/${signature}`);
    return signature;
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    throw new Error(`Raydium Swap failed: ${err.message}`);
  }
}
