import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { jitoWithAxios } from "./src/jitoWithAxios";

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || "";
const PAYERS_PATH = path.join(__dirname, ".keys", "payers.json");
const SOURCE_WALLET_PATH = path.join(__dirname, ".keys", "DevBag.json");
const RECIPIENT_PUBLIC_KEY = "rRWF6TeCzdLrwqp4LrJLnABZodwqmt2wWMKEmzGhNbu"; // Replace with the recipient's public key
const AMOUNT_TO_SEND_SOL = 0.01; // Amount in SOL
const AMOUNT_TO_SEND_LAMPORTS = AMOUNT_TO_SEND_SOL * 1e9; // Convert to lamports

// Utility functions
const loadKeypair = (filePath: string): Keypair => {
  const walletData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const secretKey = bs58.decode(walletData.secretKey);
  return Keypair.fromSecretKey(secretKey);
};

// Utility function to handle single or multiple wallets in payers.json
const loadKeypairOrRandom = (filePath: string): Keypair => {
  const walletsData = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  if (Array.isArray(walletsData)) {
    // If it's an array of keypairs, select one at random
    const randomIndex = Math.floor(Math.random() * walletsData.length);
    const selectedWallet = walletsData[randomIndex];
    console.log(`Randomly selected payer wallet: ${selectedWallet.publicKey}`);
    return Keypair.fromSecretKey(bs58.decode(selectedWallet.secretKey));
  } else if (walletsData.secretKey) {
    // If it's a single keypair, use it
    console.log(`Using single payer wallet: ${walletsData.publicKey}`);
    return Keypair.fromSecretKey(bs58.decode(walletsData.secretKey));
  } else {
    throw new Error("Invalid payers.json format: Expected an array or an object with a secretKey.");
  }
};

// Main workflow
const main = async () => {
  if (!HELIUS_RPC_URL) {
    throw new Error("HELIUS_RPC_URL is not defined in the .env file.");
  }

  const connection = new Connection(HELIUS_RPC_URL, "confirmed");

  // Load the source wallet and the payer wallet
  const sourceWallet = loadKeypair(SOURCE_WALLET_PATH);
  const payerWallet = loadKeypairOrRandom(PAYERS_PATH);

  console.log(`Source wallet: ${sourceWallet.publicKey.toBase58()}`);
  console.log(`Recipient wallet: ${RECIPIENT_PUBLIC_KEY}`);
  console.log(`Amount to send: ${AMOUNT_TO_SEND_SOL} SOL`);

    // Create the transfer instruction
    const transferInstruction = SystemProgram.transfer({
        fromPubkey: sourceWallet.publicKey,
        toPubkey: new PublicKey(RECIPIENT_PUBLIC_KEY),
        lamports: AMOUNT_TO_SEND_LAMPORTS,
    });

    // Fetch the latest blockhash
    const { blockhash } = await connection.getLatestBlockhash('finalized');

    // Create a transaction
    const message = new TransactionMessage({
        payerKey: payerWallet.publicKey, // Use payerWallet for gas fees
        instructions: [transferInstruction],
        recentBlockhash: blockhash,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);

    // Sign the transaction with the source wallet and payer wallet
    transaction.sign([sourceWallet, payerWallet]);

  console.log("Prepared transaction for Jito submission.");

  // Submit the transaction via Jito bundling
  console.log("Submitting transaction via Jito...");
  const jitoResult = await jitoWithAxios([transaction], payerWallet);

  if (jitoResult.bundleStatus) {
    console.log("🌟 Final Status:", jitoResult.bundleStatus);
  } else {
    console.error("❌ Jito bundle submission failed or status could not be retrieved.");
  }
};

main().catch((error) => console.error("Error in script execution:", error));
