import dotenv from "dotenv";
import path from "path";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { PumpFunSDK } from "./src";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import bs58 from "bs58";
import { printSOLBalance, printSPLBalance } from "./util";

// Constants
const KEYS_FOLDER = path.join(__dirname, ".keys");
const CONFIG_FILE = path.join(__dirname, "config.json");
const MINT_JSON_PATH = path.join(KEYS_FOLDER, "mint.json"); // Path to mint.json
const SLIPPAGE_BASIS_POINTS = 10000; // 1% slippage
const TRANSACTION_BATCH_SIZE = 4; // Number of wallets per batch

// Utility to batch an array
const batchArray = <T>(array: T[], batchSize: number): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
};

// Load Keypair from file
const loadKeypair = (filePath: string): Keypair => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Keypair file not found: ${filePath}`);
  }
  const walletData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
};

// Load Launcher Wallets from `launchers.json`
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

// Load Config from `config.json`
const loadConfig = (): { launcherWalletSolAmounts: Record<string, number> } => {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error("Config file not found.");
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
};

// Retry utility for transactions
const retryTransaction = async (
  transactionFn: () => Promise<string>,
  retries = 3
): Promise<string> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await transactionFn();
    } catch (error) {
      console.error(`Transaction failed on attempt ${attempt}:`, error);
      if (
        error instanceof Error &&
        error.message.includes("not a recent slot") &&
        attempt < retries
      ) {
        console.log(`Retrying transaction due to expired slot...`);
      } else {
        throw error; // Rethrow non-recoverable errors or on final attempt
      }
    }
  }
  throw new Error("Transaction failed after all retries.");
};

// Utility to fetch and validate an Address Lookup Table account
const fetchAndValidateALT = async (
  connection: Connection,
  altAddress: PublicKey,
  retries = 5,
  delayMs = 1000
): Promise<void> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const lookupTable = await connection.getAddressLookupTable(altAddress);
      if (lookupTable?.value) {
        console.log(`ALT fetched and validated: ${altAddress.toBase58()}`);
        return;
      } else {
        console.warn(
          `ALT not available yet (attempt ${attempt}/${retries}). Retrying...`
        );
      }
    } catch (error) {
      console.error(`Error fetching ALT (attempt ${attempt}/${retries}):`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Failed to fetch or validate ALT at address ${altAddress.toBase58()}`);
};

const main = async () => {
  dotenv.config();

  if (!process.env.HELIUS_RPC_URL) {
    throw new Error("Please set HELIUS_RPC_URL in the .env file");
  }

  const connection = new Connection(process.env.HELIUS_RPC_URL, "confirmed");

  // Load wallets
  const devBagPath = path.join(KEYS_FOLDER, "DevBag.json");
  const devBag = loadKeypair(devBagPath);
  const mint = loadKeypair(MINT_JSON_PATH); // Load the mint keypair from mint.json
  const launcherWallets = loadLauncherWallets();
  const config = loadConfig();
  const launcherSolAmounts = config.launcherWalletSolAmounts;

  const wallet = new Wallet(devBag);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const sdk = new PumpFunSDK(provider);

  console.log("Loaded launcher wallets:");
  launcherWallets.forEach((wallet, i) =>
    console.log(`Wallet ${i + 1}: ${wallet.publicKey.toBase58()}`)
  );

  console.log("Launcher Wallet SOL Amounts from Config:");
  console.log(JSON.stringify(launcherSolAmounts, null, 2));

  // Step 1: Create Address Lookup Table (ALT)
  console.log("Creating Address Lookup Table...");
  const slot = await connection.getSlot();
  const { blockhash } = await connection.getLatestBlockhash("finalized");

  const [altCreateIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: devBag.publicKey,
    payer: devBag.publicKey,
    recentSlot: slot,
  });

  console.log(`ALT Address: ${altAddress.toBase58()}`);

  const altTransaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: devBag.publicKey,
      recentBlockhash: blockhash,
      instructions: [altCreateIx],
    }).compileToV0Message()
  );

  altTransaction.sign([devBag]);

  const altSignature = await retryTransaction(async () =>
    connection.sendTransaction(altTransaction, { skipPreflight: false })
  );
  console.log(`ALT created successfully. Signature: ${altSignature}`);

  // **Fetch and validate the ALT**
  console.log("Validating ALT creation...");
  await fetchAndValidateALT(connection, altAddress);

  // Step 2: Extend ALT with Launcher Wallets
  console.log("Extending ALT with launcher wallets...");
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    lookupTable: altAddress,
    authority: devBag.publicKey,
    payer: devBag.publicKey,
    addresses: launcherWallets.map((w) => w.publicKey),
  });

  const extendTransaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: devBag.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [extendIx],
    }).compileToV0Message()
  );

  extendTransaction.sign([devBag]);

  const extendSignature = await retryTransaction(async () =>
    connection.sendTransaction(extendTransaction, { skipPreflight: false })
  );
  console.log(`ALT extended successfully. Signature: ${extendSignature}`);

  // Step 3: Create Bonding Curve Token
  console.log("Using existing Mint Keypair:");
  console.log(`Mint Address: ${mint.publicKey.toBase58()}`);
  const tokenMetadata = {
    name: "ABG Token",
    symbol: "ABG",
    description: "A ABG.",
    file: new Blob(["fake_image_data"]), // Replace with real image data
    twitter: "https://twitter.com/thetweet", // Twitter URL
    telegram: "https://t.me/thetelegram", // Telegram group link
    website: "https://thegoogle.com", // Website URL
  
  };

  const initialBuyAmount = BigInt(0.1 * LAMPORTS_PER_SOL);
  const bondingCurveParams = {
    unitLimit: 250_000, // Max supply of tokens
    unitPrice: 250_000, // Initial price in lamports
  };

  const createResults = await sdk.createAndBuy(
    devBag,
    mint,
    tokenMetadata,
    initialBuyAmount,
    SLIPPAGE_BASIS_POINTS,
    bondingCurveParams
  );

  if (createResults.success) {
    console.log(
      `Bonding curve token created successfully: https://pump.fun/${mint.publicKey.toBase58()}`
    );
  } else {
    console.error("Failed to create bonding curve token.");
    return;
  }

  // Print initial SPL balance for DevBag
  await printSPLBalance(connection, mint.publicKey, devBag.publicKey, "DevBag");

  // Step 4: Launcher Wallets Buy Tokens Using ALT
  console.log("Executing buys using ALT in batches...");

  const launcherBatches = batchArray(launcherWallets, TRANSACTION_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < launcherBatches.length; batchIndex++) {
    const batch = launcherBatches[batchIndex];
    console.log(`Processing batch ${batchIndex + 1} of ${launcherBatches.length}`);

    const transactionInstructions: TransactionInstruction[] = [];
    const signers: Keypair[] = [devBag];

    for (const launcher of batch) {
      const solAmount = launcherSolAmounts[launcher.publicKey.toBase58()] || 0;
      const lamportsAmount = BigInt(solAmount * LAMPORTS_PER_SOL);

      console.log(
        `Launcher ${launcher.publicKey.toBase58()} attempting to buy ${solAmount} SOL (${lamportsAmount} lamports)`
      );

      const buyIx = await sdk.getBuyInstructionsBySolAmount(
        launcher.publicKey,
        mint.publicKey,
        lamportsAmount,
        SLIPPAGE_BASIS_POINTS
      );

      transactionInstructions.push(...buyIx.instructions);
      signers.push(launcher);
    }

    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: devBag.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: transactionInstructions,
      }).compileToV0Message()
    );

    transaction.sign(signers);

    try {
      const txSignature = await connection.sendTransaction(transaction);
      console.log(`Batch ${batchIndex + 1} sent successfully. Signature: ${txSignature}`);
    } catch (error) {
      console.error(`Failed to send batch ${batchIndex + 1}:`, error);
    }
  }

  console.log("All operations completed successfully.");
};

main().catch(console.error);
