import dotenv from "dotenv";
import bs58 from "bs58"; // Make sure bs58 is imported
import fs from "node:fs";
import path from "path";
import { Connection, Keypair, Transaction, VersionedTransaction,TransactionMessage, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DEFAULT_DECIMALS, PumpFunSDK } from "./src";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  getOrCreateKeypair,
  getSPLBalance,
  printSOLBalance,
  printSPLBalance,
} from "./util";

const KEYS_FOLDER = __dirname + "/.keys";
const LAUNCHERS_FILE = path.join(KEYS_FOLDER, "launchers.json");
const CONFIG_FILE = path.join(__dirname, "config.json");
const SLIPPAGE_BASIS_POINTS = 100n;
const USE_ATOMIC_BUY = true; // Toggle atomic buy functionality
// Load static wallets from launchers.json
const loadLaunchers = (): Keypair[] => {
  console.log("Loading launchers from:", LAUNCHERS_FILE);
  const launchersData = JSON.parse(fs.readFileSync(LAUNCHERS_FILE, "utf-8"));
  return launchersData.map((launcher: {
    publicKey: any; secretKey: string 
}) => {
    try {
      const secretKeyBuffer = bs58.decode(launcher.secretKey);
      return Keypair.fromSecretKey(secretKeyBuffer);
    } catch (error) {
      console.error(`Failed to load launcher with publicKey: ${launcher.publicKey}`);
      console.error(`Error: ${error.message}`);
      throw error; // Ensure the application stops if a launcher is invalid
    }
  });
};

// Load configuration parameters from config.json
const loadConfig = () => {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
};

const main = async () => {
  dotenv.config();

  if (!process.env.HELIUS_RPC_URL) {
    console.error("Please set HELIUS_RPC_URL in .env file");
    console.error(
      "Example: HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<your api key>"
    );
    console.error("Get one at: https://www.helius.dev");
    return;
  }

  const connection = new Connection(process.env.HELIUS_RPC_URL || "");
  const wallet = new NodeWallet(new Keypair());
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "finalized",
  });

  const DevBag = getOrCreateKeypair(KEYS_FOLDER, "DevBag");
  const mint = getOrCreateKeypair(KEYS_FOLDER, "mint");

  await printSOLBalance(connection, DevBag.publicKey, "DevBag keypair");

  const sdk = new PumpFunSDK(provider);
  const globalAccount = await sdk.getGlobalAccount();
  console.log(globalAccount);

  const currentSolBalance = await connection.getBalance(DevBag.publicKey);
  if (currentSolBalance === 0) {
    console.log(
      "Please send some SOL to the DevBag:",
      DevBag.publicKey.toBase58()
    );
    return;
  }

  console.log(await sdk.getGlobalAccount());

  let boundingCurveAccount = await sdk.getBondingCurveAccount(mint.publicKey);
  const otherWallets = loadLaunchers();
  console.log(
    "Loaded launcher wallets:",
    otherWallets.map((wallet) => wallet.publicKey.toBase58())
  );

  const config = loadConfig();
  console.log("Loaded config:", config);

  let tokenMetadata;

  if (!boundingCurveAccount) {
    try {
      const filePath = path.resolve(__dirname, "random.png");
      tokenMetadata = {
        name: "TST-7",
        symbol: "TST-7",
        description: "TST-7: This is a test token",
        file: await fs.openAsBlob(filePath),
        ...(process.env.TWITTER && { twitter: process.env.TWITTER }),
        ...(process.env.TELEGRAM && { telegram: process.env.TELEGRAM }),
        ...(process.env.WEBSITE && { website: process.env.WEBSITE }),
      };
    } catch (error) {
      console.error("Error occurred while creating a Blob from the file:", error);
      throw error;
    }

    try {
      if (USE_ATOMIC_BUY) {
        console.log("Using atomic bundle buy functionality...");

        const transaction = new Transaction();

        // Add create instructions for DevBag
        const createInstructions = await sdk.getCreateInstructions(
          DevBag.publicKey,
          tokenMetadata.name,
          tokenMetadata.symbol,
          (await sdk.createTokenMetadata(tokenMetadata)).metadataUri,
          mint
        );
        transaction.add(createInstructions);
        // Add buy instructions for DevBag
        const devBagBuyPrice = globalAccount.getInitialBuyPrice(BigInt(config.launcherWalletSolAmounts * LAMPORTS_PER_SOL));
        const devBagSolAmount = globalAccount.getInitialBuyPrice(BigInt(config.launcherWalletSolAmounts * LAMPORTS_PER_SOL));
        const devBagBuyInstructions = await sdk.getBuyInstructions(
          DevBag.publicKey,
          mint.publicKey,
          globalAccount.feeRecipient,
          devBagBuyPrice,
          devBagSolAmount
        );
        transaction.add(devBagBuyInstructions);

        for (const wallet of otherWallets) {
          const solAmount = config.launcherWalletSolAmounts[wallet.publicKey.toBase58()];
          console.log(`Wallet: ${wallet.publicKey.toBase58()}, SOL Amount: ${solAmount}`);


          if (solAmount == null) {
            console.log(`Skipping wallet: ${wallet.publicKey.toBase58()} due to missing SOL amount`);
            continue; // Skip wallets without a defined SOL amount
          }
    
          const walletBuyPrice = globalAccount.getInitialBuyPrice(BigInt(solAmount * LAMPORTS_PER_SOL));
          const walletSolAmount = globalAccount.getInitialBuyPrice(BigInt(solAmount * LAMPORTS_PER_SOL));

          const walletBuyInstructions = await sdk.getBuyInstructions(
            wallet.publicKey,
            mint.publicKey,
            globalAccount.feeRecipient,
            walletBuyPrice,
            walletSolAmount
          );
          transaction.add(walletBuyInstructions);
        }

    // Convert legacy transaction to VersionedTransaction
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const message = new TransactionMessage({
      payerKey: DevBag.publicKey,
      recentBlockhash,
      instructions: transaction.instructions,
    }).compileToV0Message();
    const versionedTransaction = new VersionedTransaction(message);

    // Sign the transaction
    versionedTransaction.sign([DevBag, mint, ...otherWallets]);

    // Send the signed transaction
    const transactionSignature = await connection.sendTransaction(versionedTransaction, {
      preflightCommitment: "finalized",
    });


        console.log("Atomic transaction successful:", transactionSignature);
      } else {
        console.log("Executing createAndBuy individually...");
        const createResults = await sdk.createAndBuy(
          DevBag,
          mint,
          tokenMetadata,
          BigInt(0.0001 * LAMPORTS_PER_SOL),
          SLIPPAGE_BASIS_POINTS,
          { unitLimit: 250000, unitPrice: 250000 }
        );

        if (createResults.success) {
          console.log(
            "Success:",
            `https://pump.fun/${mint.publicKey.toBase58()}`
          );
        }
      }

      boundingCurveAccount = await sdk.getBondingCurveAccount(mint.publicKey);
      console.log("Bonding curve after create and buy", boundingCurveAccount);

      await printSPLBalance(connection, mint.publicKey, DevBag.publicKey);
    } catch (error) {
      console.error(
        USE_ATOMIC_BUY
          ? "Atomic transaction failed:"
          : "createAndBuy operation failed:",
        error
      );
    }
  } else {
    console.log("boundingCurveAccount", boundingCurveAccount);
    console.log("Success:", `https://pump.fun/${mint.publicKey.toBase58()}`);
    await printSPLBalance(connection, mint.publicKey, DevBag.publicKey);
  }

  if (boundingCurveAccount) {
    // Buy 0.0001 SOL worth of tokens
    const buyResults = await sdk.buy(
      DevBag,
      mint.publicKey,
      BigInt(0.0001 * LAMPORTS_PER_SOL),
      SLIPPAGE_BASIS_POINTS,
      {
        unitLimit: 250000,
        unitPrice: 250000,
      }
    );

    if (buyResults.success) {
      await printSPLBalance(connection, mint.publicKey, DevBag.publicKey);
      console.log(
        "Bonding curve after buy",
        await sdk.getBondingCurveAccount(mint.publicKey)
      );
    } else {
      console.log("Buy failed");
    }

    // Sell all tokens
    const currentSPLBalance = await getSPLBalance(
      connection,
      mint.publicKey,
      DevBag.publicKey
    );
    console.log("currentSPLBalance", currentSPLBalance);

    if (currentSPLBalance) {
      const sellResults = await sdk.sell(
        DevBag,
        mint.publicKey,
        BigInt(currentSPLBalance * Math.pow(10, DEFAULT_DECIMALS)),
        SLIPPAGE_BASIS_POINTS,
        {
          unitLimit: 250000,
          unitPrice: 250000,
        }
      );

      if (sellResults.success) {
        await printSOLBalance(connection, DevBag.publicKey, "DevBag keypair");

        await printSPLBalance(
          connection,
          mint.publicKey,
          DevBag.publicKey,
          "After SPL sell all"
        );
        console.log(
          "Bonding curve after sell",
          await sdk.getBondingCurveAccount(mint.publicKey)
        );
      } else {
        console.log("Sell failed");
      }
    }
  }
};

main();
