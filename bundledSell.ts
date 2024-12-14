import {
    Keypair,
    PublicKey,
    Connection,
    TransactionMessage,
    VersionedTransaction,
    AddressLookupTableProgram,
    TransactionInstruction,
  } from "@solana/web3.js";
  import * as fs from "fs";
  import * as path from "path";
  import bs58 from "bs58";
  import dotenv from "dotenv";
  import { printSOLBalance, printSPLBalance, getSPLBalance } from "./util";
  import { PumpFunSDK } from "./src";
  import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
  
  dotenv.config(); // Load environment variables
  
  // Constants
  const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || "";
  const KEYS_DIR = path.join(__dirname, ".keys"); // Path to the .keys directory
  const MINT_JSON_PATH = path.join(KEYS_DIR, "mint.json"); // Path to mint.json
  const SLIPPAGE_BASIS_POINTS = 10000n; // undefined; for Unlimited slippage // BigInt("10000"); for %
  const SELLER_WALLETS = ["DevBag.json","launchers.json"]; // Specify wallets
  const MAX_WALLETS_PER_TX = 4; // Max number of wallet instructions packed into a single transaction
  
  // Utility to load specific wallets from files
  const loadKeypairsFromFiles = (dir: string, walletFiles: string[]): Keypair[] => {
    const keypairs: Keypair[] = [];
  
    walletFiles.forEach((fileName) => {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Wallet file not found: ${filePath}`);
      }
  
      const walletData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  
      if (Array.isArray(walletData)) {
        // Handle case where the file is an array of keypairs
        walletData.forEach((wallet) => {
          if (!wallet.secretKey) {
            throw new Error(`Invalid wallet format in ${fileName}: Missing 'secretKey'`);
          }
          keypairs.push(Keypair.fromSecretKey(bs58.decode(wallet.secretKey)));
        });
      } else if (walletData.secretKey) {
        // Handle case where the file is a single keypair
        keypairs.push(Keypair.fromSecretKey(bs58.decode(walletData.secretKey)));
      } else {
        throw new Error(`Invalid wallet format in ${fileName}`);
      }
    });
  
    return keypairs;
  };
  
  // Utility to retry async functions
  const retryAsync = async (fn: () => Promise<any>, retries: number, delayMs: number): Promise<any> => {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        console.warn(`Retry ${i + 1} failed: ${error.message}`);
        if (i === retries - 1) {
          throw new Error(`Exceeded maximum retries for operation: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
  
  const batchArray = <T>(array: T[], batchSize: number): T[][] => {
    const batches: T[][] = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }
    return batches;
  };
  
  const main = async () => {
    // Step 1: Setup connection and load resources
    const connection = new Connection(HELIUS_RPC_URL, "confirmed");
  
    // Load wallets specified in SELLER_WALLETS
    const sellerWallets = loadKeypairsFromFiles(KEYS_DIR, SELLER_WALLETS);
    const mintData = JSON.parse(fs.readFileSync(MINT_JSON_PATH, "utf-8")); // Load mint.json
    const splTokenMint = new PublicKey(mintData.publicKey); // SPL token mint address
  
    console.log(`🚀 Starting bundled sell process`);
    console.log(`🪙 SPL Token Mint Address: ${splTokenMint.toBase58()}`);
    console.log(`🔑 Loaded ${sellerWallets.length} seller wallets from ${KEYS_DIR}`);
  
    // Initialize PumpFunSDK with a custom Anchor Provider
    const provider = new AnchorProvider(
      connection,
      new Wallet(sellerWallets[0]), // Use the first wallet in SELLER_WALLETS for the provider
      { commitment: "confirmed" }
    );
    const sdk = new PumpFunSDK(provider);
  
    // Step 2: Create Address Lookup Table (ALT)
    console.log("📜 Creating Address Lookup Table (ALT)...");
  
    const altAuthority = sellerWallets[0]; // Use the first wallet as the ALT authority
  
    // Retry ALT creation
    const { lookupTableAddress, createLookupInstruction } = await retryAsync(
      async () => {
        const recentSlot = await connection.getSlot();
        const [instruction, address] = AddressLookupTableProgram.createLookupTable({
          authority: altAuthority.publicKey,
          payer: altAuthority.publicKey,
          recentSlot,
        });
        return { lookupTableAddress: address, createLookupInstruction: instruction };
      },
      5, // Maximum retries
      1000 // Delay in milliseconds
    );
  
    console.log(`✅ ALT Address: ${lookupTableAddress.toBase58()}`);
  
    // Step 3: Extend ALT with seller wallet addresses
    console.log("📤 Extending Address Lookup Table (ALT)...");
  
    const extendALTInstruction = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lookupTableAddress,
      payer: altAuthority.publicKey,
      authority: altAuthority.publicKey,
      addresses: sellerWallets.map((wallet) => wallet.publicKey),
    });
  
    // Step 4: Combine ALT creation and extension instructions
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    const altTransactionMessage = new TransactionMessage({
      payerKey: altAuthority.publicKey,
      instructions: [createLookupInstruction, extendALTInstruction],
      recentBlockhash: blockhash,
    }).compileToV0Message();
  
    const altTransaction = new VersionedTransaction(altTransactionMessage);
    altTransaction.sign([altAuthority]);
  
    try {
      const altSignature = await connection.sendTransaction(altTransaction, {
        skipPreflight: false,
      });
      console.log(`✅ ALT creation and extension transaction sent: ${altSignature}`);
  
      // Wait for confirmation
      await retryAsync(
        async () => {
          const latestBlockhash = await connection.getLatestBlockhash("finalized");
  
          await connection.confirmTransaction(
            {
              signature: altSignature,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            "confirmed"
          );
        },
        5,
        2000 // Retry every 2 seconds
      );
  
      console.log("✅ ALT successfully created and extended.");
    } catch (error) {
      console.error("❌ ALT creation and extension failed:", error);
      return;
    }
  
    // Step 5: Fetch and verify the ALT
    console.log("📜 Fetching Address Lookup Table (ALT)...");
  
    const lookupTableAccount = await retryAsync(
      async () => {
        const alt = await connection.getAddressLookupTable(lookupTableAddress);
        if (!alt.value) {
          throw new Error("ALT not found");
        }
        return alt.value;
      },
      5,
      1000
    );
  
    console.log(`✅ ALT fetched successfully: ${lookupTableAccount.key.toBase58()}`);
  
    // Step 6: Fetch all token accounts for sellers and create sell transactions
    console.log("🔄 Creating sell transactions...");
    const walletBatches = batchArray(sellerWallets, MAX_WALLETS_PER_TX); // Group wallets into batches
  
    for (const batch of walletBatches) {
      console.log(`🔍 Processing batch with ${batch.length} wallets`);
  
      const instructions: TransactionInstruction[] = [];
      const validSigners: Keypair[] = []; // Collect only valid signers
  
      for (const wallet of batch) {
        console.log(`🔍 Processing wallet: ${wallet.publicKey.toBase58()}`);
  
        // Fetch SPL token balance
        const balance = await getSPLBalance(connection, splTokenMint, wallet.publicKey);
        if (!balance || balance === 0) {
          console.log(`⚠️ Wallet ${wallet.publicKey.toBase58()} has no SPL tokens to sell. Skipping.`);
          continue;
        }
  
        console.log(`💰 Wallet ${wallet.publicKey.toBase58()} SPL Token Balance: ${balance}`);
        validSigners.push(wallet);
  
        // Generate sell instructions
        const sellInstructions = await sdk.getSellInstructionsByTokenAmount(
          wallet.publicKey,
          splTokenMint,
          BigInt(balance * Math.pow(10, 6)), // Convert balance to smallest units
          SLIPPAGE_BASIS_POINTS
        );
  
        instructions.push(...sellInstructions.instructions);
      }
  
      if (instructions.length === 0) {
        console.log("⚠️ No valid sell instructions for this batch. Skipping.");
        continue;
      }
  
      // Create the transaction
      const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const transactionMessage = new TransactionMessage({
        payerKey: altAuthority.publicKey,
        instructions,
        recentBlockhash: blockhash,
      }).compileToV0Message([lookupTableAccount]);
  
      const transaction = new VersionedTransaction(transactionMessage);
      transaction.sign([altAuthority, ...validSigners]);
  
      // Log transaction size
      const size = transaction.serialize().length;
      console.log(`📏 Transaction size: ${size} bytes`);
  
      // Check transaction size
      if (size > 1200) {
        console.error(`❌ Transaction size exceeds the limit (${size} bytes). Skipping batch.`);
        continue;
      }
  
      // Send the transaction
      try {
        console.log("🚀 Submitting transaction...");
        const txSignature = await connection.sendTransaction(transaction, { skipPreflight: false });
        console.log(`✅ Transaction sent successfully: ${txSignature}`);
  
        // Confirm the transaction
        await retryAsync(async () => {
          const latestBlockhash = await connection.getLatestBlockhash("confirmed");
          await connection.confirmTransaction(
            {
              signature: txSignature,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            "confirmed"
          );
        }, 5, 2000);
  
        console.log("✅ Transaction confirmed.");
      } catch (error) {
        console.error("❌ Transaction failed:", error);
      }
    }
  };
  
  main().catch((error) => console.error("❌ Script execution error:", error));
  