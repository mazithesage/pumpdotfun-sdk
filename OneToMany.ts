import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
    Connection,
    Keypair,
    SystemProgram,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    AddressLookupTableProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { jitoWithAxios } from './src/jitoWithAxios'; // Import Jito with Axios

// Load environment variables
dotenv.config();
const heliusRpcUrl = process.env.HELIUS_RPC_URL;
if (!heliusRpcUrl) {
    throw new Error("HELIUS_RPC_URL is not defined in the .env file.");
}

// Constants
const RECIPIENTS_PATH = path.join(__dirname, '.keys', 'launchers.json');
const PAYERS_PATH = path.join(__dirname, '.keys', 'payers.json');
const SOURCE_WALLET_PATH = path.join(__dirname, '.keys', 'DevBag.json');
const AMOUNT_TO_SEND_SOL = 0.01; // Amount in SOL
const AMOUNT_TO_SEND_LAMPORTS = AMOUNT_TO_SEND_SOL * 1e9; // Convert to lamports

// Utility functions
const loadKeypair = (filePath: string): Keypair => {
    const walletData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const secretKey = bs58.decode(walletData.secretKey);
    return Keypair.fromSecretKey(secretKey);
};

const loadKeypairs = (filePath: string): Keypair[] => {
    const walletsData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Check if `walletsData` is an array or a single object
    if (Array.isArray(walletsData)) {
        // If it's an array, map over it
    return walletsData.map((wallet: { secretKey: string }) => {
        const secretKey = bs58.decode(wallet.secretKey);
        return Keypair.fromSecretKey(secretKey);
    });
    } else if (typeof walletsData === 'object' && walletsData.secretKey) {
        // If it's a single object, wrap it into an array
        const secretKey = bs58.decode(walletsData.secretKey);
        return [Keypair.fromSecretKey(secretKey)];
    } else {
        throw new Error('Invalid format in payers.json. Expected an array or a single keypair object.');
    }
};

const loadRecipients = (filePath: string): PublicKey[] => {
    const recipientsData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return recipientsData.map((recipient: { publicKey: string }) => new PublicKey(recipient.publicKey));
};

const getRandomPayer = (payers: Keypair[]): Keypair => {
    const randomIndex = Math.floor(Math.random() * payers.length);
    return payers[randomIndex];
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchLookupTable = async (
    connection: Connection,
    lookupTableAddress: PublicKey,
    retries = 10,
    delayMs = 500
): Promise<any> => {
    for (let i = 0; i < retries; i++) {
        try {
            const lookupTable = await connection.getAddressLookupTable(lookupTableAddress);
            if (lookupTable.value) {
                console.log(`Fetched ALT on retry ${i + 1}`);
                return lookupTable.value;
            }
        } catch (error) {
            console.error(`Error fetching ALT on retry ${i + 1}:`, error);
        }

        console.log(`Retrying to fetch Address Lookup Table... (${i + 1}/${retries})`);
        await delay(delayMs);
    }
    throw new Error('Failed to fetch the Address Lookup Table account after retries.');
};

// Main workflow
const main = async () => {
    const connection = new Connection(heliusRpcUrl, 'confirmed');
    const sourceWallet = loadKeypair(SOURCE_WALLET_PATH);
    const recipients = loadRecipients(RECIPIENTS_PATH);
    const payers = loadKeypairs(PAYERS_PATH);

    // Randomly select a wallet to pay for gas
    const payerWallet = getRandomPayer(payers);

    console.log(`Source wallet: ${sourceWallet.publicKey.toBase58()}`);
    console.log(`Randomly selected payer wallet: ${payerWallet.publicKey.toBase58()}`);
    console.log(`Loaded ${recipients.length} recipient wallets.`);

    // Step 1: Create and Extend Address Lookup Table
    let slot = await connection.getSlot();
    const [createLookupInstruction, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
        authority: sourceWallet.publicKey,
        payer: payerWallet.publicKey, // Payer is set to the randomly selected wallet
        recentSlot: slot,
    });

    const extendLookupInstruction = AddressLookupTableProgram.extendLookupTable({
        lookupTable: lookupTableAddress,
        payer: payerWallet.publicKey, // Payer is set to the randomly selected wallet
        authority: sourceWallet.publicKey,
        addresses: recipients,
    });

    console.log(`Address Lookup Table to be created: ${lookupTableAddress.toBase58()}`);

    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        const message = new TransactionMessage({
            payerKey: payerWallet.publicKey, // Set payerKey to the random payer wallet
            instructions: [createLookupInstruction, extendLookupInstruction],
            recentBlockhash: blockhash,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        transaction.sign([payerWallet, sourceWallet]);

        console.log('🚀 Sending ALT creation and extension transaction...');
        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });

        console.log(`📝 ALT creation and extension transaction sent: ${signature}`);
        console.log('⏳ Waiting for transaction confirmation...');
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        console.log(`✅ Transaction finalized: ${signature}`);
    } catch (error) {
        console.error('❌ Error during ALT creation/extension:', error);
        return;
    }

    console.log(`⏳ Waiting for ALT propagation at address: ${lookupTableAddress.toBase58()}`);
    const lookupTableAccount = await fetchLookupTable(connection, lookupTableAddress, 10, 500);

    if (!lookupTableAccount || !lookupTableAccount.key) {
        throw new Error('❌ Failed to fetch or retrieve the Address Lookup Table account.');
    }
    console.log(`✅ Fetched Address Lookup Table: ${lookupTableAccount.key.toBase58()}`);

    // Step 3: Create Transactions and Submit via Jito Bundling
    console.log("Preparing transfer instructions...");

    // Create transfer instructions
    const transferInstructions = recipients.map((recipient) =>
        SystemProgram.transfer({
            fromPubkey: sourceWallet.publicKey,
            toPubkey: recipient,
            lamports: AMOUNT_TO_SEND_LAMPORTS,
        })
    );

    // Split transfer instructions into smaller transactions for bundling
    const { blockhash } = await connection.getLatestBlockhash('finalized');
    const transactions: VersionedTransaction[] = [];
    const batchSize = 5; // Bundle 5 instructions per transaction
    for (let i = 0; i < transferInstructions.length; i += batchSize) {
        const batchInstructions = transferInstructions.slice(i, i + batchSize);
        const message = new TransactionMessage({
            payerKey: payerWallet.publicKey, // Use payerWallet for gas fees
            instructions: batchInstructions,
            recentBlockhash: blockhash,
        }).compileToV0Message([lookupTableAccount]); // Use the ALT for optimized transactions

        const transaction = new VersionedTransaction(message);
        transaction.sign([payerWallet, sourceWallet]);
        transactions.push(transaction);
    }

    console.log(`Prepared ${transactions.length} transactions for Jito submission.`);

    // Submit transactions via Jito with Axios
    console.log("Submitting transactions via Jito with Axios...");
    const jitoResult = await jitoWithAxios(transactions, payerWallet);
    if (jitoResult.confirmed) {
        console.log("✅ Jito bundle successfully confirmed.");
    } else {
        console.log("❌ Jito bundle submission failed.");
    }
};

main().catch((error) => console.error('Error in script execution:', error));
