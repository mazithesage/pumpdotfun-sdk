import dotenv from "dotenv";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { PumpFunSDK } from "./src";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";

// Constants
const KEYS_FOLDER = path.join(__dirname, ".keys");
const CONFIG_FILE = path.join(__dirname, "config.json");
const SLIPPAGE_BASIS_POINTS = 100n;
const MAX_TRANSACTION_SIZE = 1232; // Max raw transaction size in bytes

// Utility Functions
const loadKeypair = (filePath: string): Keypair => {
  const walletData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
};

const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));

const loadLauncherWallets = (): Keypair[] => {
  const launchersPath = path.join(KEYS_FOLDER, "launchers.json");
  if (!fs.existsSync(launchersPath)) {
    throw new Error("Launcher wallets file not found.");
  }
  const launchersData = JSON.parse(fs.readFileSync(launchersPath, "utf-8"));
  return launchersData.map((launcher: { secretKey: string }) =>
    Keypair.fromSecretKey(bs58.decode(launcher.secretKey))
  );
};

const printSOLBalance = async (connection: Connection, publicKey: PublicKey, label: string) => {
  const balance = await connection.getBalance(publicKey);
  console.log(`${label} ${publicKey.toBase58()}: ${(balance / LAMPORTS_PER_SOL).toFixed(8)} SOL`);
};

const fetchLookupTable = async (connection: Connection, lookupTableAddress: PublicKey) => {
  const lookupTableAccount = await connection.getAddressLookupTable(lookupTableAddress);
  if (!lookupTableAccount.value) {
    throw new Error(`Failed to fetch ALT: ${lookupTableAddress.toBase58()}`);
  }
  return lookupTableAccount.value;
};

const sendTransaction = async (
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  lookupTableAccount?: PublicKey[],
  signers: Keypair[] = []
) => {
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccount);

  const transaction = new VersionedTransaction(message);
  transaction.sign([payer, ...signers]);

  const serializedSize = transaction.serialize().length;
  console.log(`Serialized Transaction Size: ${serializedSize} bytes`);
  if (serializedSize > MAX_TRANSACTION_SIZE) {
    throw new Error(`Transaction size (${serializedSize} bytes) exceeds the limit.`);
  }

  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log(`Transaction sent. Signature: ${signature}`);
  return signature;
};

// Main Script
const main = async () => {
  dotenv.config();

  if (!process.env.HELIUS_RPC_URL) {
    throw new Error("Please set HELIUS_RPC_URL in the .env file");
  }

  const connection = new Connection(process.env.HELIUS_RPC_URL, "confirmed");

  // Load the DevBag wallet
  const devBagPath = path.join(KEYS_FOLDER, "DevBag.json");
  const devBag = loadKeypair(devBagPath);
  const wallet = new Wallet(devBag);

  // Create AnchorProvider with explicitly passed wallet
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Initialize PumpFunSDK
  const sdk = new PumpFunSDK(provider);

  const config = loadConfig();
  const launcherWallets = loadLauncherWallets();
  console.log("Loaded launcher wallets:", launcherWallets.map((w) => w.publicKey.toBase58()));

  const mint = Keypair.generate();
  const globalAccount = await sdk.getGlobalAccount();

  // Step 1: Create and Buy
  console.log("Creating and buying...");
  const createTokenMetadata = {
    name: "Test Token",
    symbol: "TST",
    description: "Test Token Description",
    file: new Blob(["fake_image_data"]),
  };
  const buyAmountSol = BigInt(0.1 * LAMPORTS_PER_SOL);

  const createAndBuyResult = await sdk.createAndBuy(
    devBag,
    mint,
    createTokenMetadata,
    buyAmountSol,
    SLIPPAGE_BASIS_POINTS
  );
  console.log(`Create and Buy executed. Signature: ${createAndBuyResult.signatures.join(", ")}`);

  // Step 2: Create Address Lookup Table
  console.log("Creating Address Lookup Table...");
  const { blockhash } = await connection.getLatestBlockhash();
  const [createInstruction, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: devBag.publicKey,
    payer: devBag.publicKey,
    recentSlot: await connection.getSlot(),
  });
  await sendTransaction(connection, devBag, [createInstruction]);
  console.log(`Address Lookup Table created: ${lookupTableAddress.toBase58()}`);

  // Step 3: Extend Address Lookup Table
  console.log("Extending Address Lookup Table...");
  const accountsToInclude = launcherWallets.map((w) => w.publicKey);
  accountsToInclude.push(mint.publicKey, globalAccount.feeRecipient);
  const extendInstruction = AddressLookupTableProgram.extendLookupTable({
    lookupTable: lookupTableAddress,
    payer: devBag.publicKey,
    authority: devBag.publicKey,
    addresses: accountsToInclude,
  });
  await sendTransaction(connection, devBag, [extendInstruction]);
  console.log("ALT extended.");

  // Step 4: Execute Buys with ALT
  console.log("Executing buys...");
  for (const launcher of launcherWallets) {
    const solAmount = config.launcherWalletSolAmounts[launcher.publicKey.toBase58()] || 0.05;
    const lamportsAmount = BigInt(solAmount * LAMPORTS_PER_SOL);

    const buyInstructions = await sdk.getBuyInstructions(
      launcher.publicKey,
      mint.publicKey,
      globalAccount.feeRecipient,
      lamportsAmount,
      lamportsAmount
    );

    await sendTransaction(
      connection,
      devBag,
      buyInstructions.instructions,
      [await fetchLookupTable(connection, lookupTableAddress)],
      [launcher]
    );
  }

  console.log("All transactions completed successfully.");
};

main().catch(console.error);
