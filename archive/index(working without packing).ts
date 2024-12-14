import dotenv from "dotenv";
import path from "path";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  Keypair,
} from "@solana/web3.js";
import { PumpFunSDK } from "./src";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import bs58 from "bs58";
import { printSOLBalance, printSPLBalance } from "./util"; // Utility functions for balance debugging

// Constants
const KEYS_FOLDER = path.join(__dirname, ".keys");
const CONFIG_FILE = path.join(__dirname, "config.json");
const SLIPPAGE_BASIS_POINTS = 100n; // 1% slippage
const TRANSACTION_BATCH_SIZE = 4; // Number of transactions per batch

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
  const walletData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
};

// Load Launcher Wallets from launchers.json
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

// Load Config from config.json
const loadConfig = (): { launcherWalletSolAmounts: Record<string, number> } => {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error("Config file not found.");
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
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

  // Print initial SOL balances
  await printSOLBalance(connection, devBag.publicKey, "DevBag Balance");
  for (const wallet of launcherWallets) {
    await printSOLBalance(connection, wallet.publicKey, "Launcher Wallet");
  }

  // Step 1: Create Address Lookup Table (ALT)
  console.log("Creating Address Lookup Table...");
  const [altInstruction, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: devBag.publicKey,
      payer: devBag.publicKey,
      recentSlot: await connection.getSlot("confirmed"),
    });

  const altTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: devBag.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [altInstruction],
    }).compileToV0Message()
  );
  altTx.sign([devBag]);

  const altSig = await connection.sendTransaction(altTx, { skipPreflight: true });
  console.log(`ALT created successfully. Signature: ${altSig}`);
  console.log(`Lookup Table Address: ${lookupTableAddress.toBase58()}`);

  // Step 2: Create Bonding Curve Token
  console.log("Creating Bonding Curve Token...");
  const mint = Keypair.generate();
  const tokenMetadata = {
    name: "Bonding Curve Token",
    symbol: "BCT",
    description: "A token with bonding curve pricing.",
    file: new Blob(["fake_image_data"]), // Replace with real image data
  };

  const initialBuyAmount = BigInt(0.1 * LAMPORTS_PER_SOL);
  const bondingCurveParams = {
    unitLimit: 250_000, // Max supply of tokens
    unitPrice: 250_000, // Initial price in lamports
  };

  let boundingCurveAccount = await sdk.getBondingCurveAccount(mint.publicKey);

  if (!boundingCurveAccount) {
    console.log("Creating bonding curve account...");

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
      boundingCurveAccount = await sdk.getBondingCurveAccount(mint.publicKey);
    } else {
      console.error("Failed to create bonding curve token.");
      return;
    }
  } else {
    console.log("Bonding curve account already exists.");
  }

  // Print initial SPL balance for DevBag
  await printSPLBalance(connection, mint.publicKey, devBag.publicKey, "DevBag");

  // Step 3: Execute Purchases Using ALT in Batches
  console.log("Executing buys using ALT in batches...");

  for (const launcher of launcherWallets) {
    const solAmount = launcherSolAmounts[launcher.publicKey.toBase58()] || 0;
    const lamportsAmount = BigInt(solAmount * LAMPORTS_PER_SOL);

    console.log(
      `Launcher ${launcher.publicKey.toBase58()} attempting to buy ${solAmount} SOL (${lamportsAmount} lamports)`
    );

    let success = false;

    for (let retry = 0; retry < 3; retry++) {
      const dynamicSlippage = SLIPPAGE_BASIS_POINTS + BigInt(retry * 100); // Increment slippage by 1% on each retry
      console.log(`Retry ${retry + 1}: Using slippage of ${dynamicSlippage} basis points`);

      try {
        const walletBalance = await connection.getBalance(launcher.publicKey);
        console.log(`Wallet Balance: ${walletBalance} lamports`);

        if (walletBalance < lamportsAmount) {
          console.error(
            `Insufficient balance for wallet ${launcher.publicKey.toBase58()}: ` +
            `${walletBalance} lamports required: ${lamportsAmount} lamports`
          );
          break;
        }

        const buyResults = await sdk.buy(
          launcher,
          mint.publicKey,
          lamportsAmount,
          dynamicSlippage,
          bondingCurveParams
        );

        if (buyResults.success) {
          console.log(
            `Launcher ${launcher.publicKey.toBase58()} bought tokens successfully on retry ${retry + 1}.`
          );
          await printSPLBalance(
            connection,
            mint.publicKey,
            launcher.publicKey,
            "Launcher Wallet"
          );
          success = true;
          break; // Exit retry loop
        }
      } catch (e) {
        console.error(`Retry ${retry + 1} failed for launcher ${launcher.publicKey.toBase58()}: ${e.message}`);
      }
    }

    if (!success) {
      console.error(`Launcher ${launcher.publicKey.toBase58()} failed to buy tokens after retries.`);
    }
  }

  console.log("All operations completed successfully.");
};

main().catch(console.error);
