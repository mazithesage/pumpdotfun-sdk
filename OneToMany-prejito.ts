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
const AMOUNT_TO_SEND_SOL = 0.3; // Amount in SOL
const AMOUNT_TO_SEND_LAMPORTS = AMOUNT_TO_SEND_SOL * 1e9; // Convert to lamports

// Utility functions
const loadKeypair = (filePath: string): Keypair => {
    const walletData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const secretKey = bs58.decode(walletData.secretKey);
    return Keypair.fromSecretKey(secretKey);
};

const loadKeypairs = (filePath: string): Keypair[] => {
    const walletsData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // Handle the case where walletsData is an array
    if (Array.isArray(walletsData)) {
    return walletsData.map((wallet: { secretKey: string }) => {
        const secretKey = bs58.decode(wallet.secretKey);
        return Keypair.fromSecretKey(secretKey);
    });
}

// Handle the case where walletsData is a single object
if (typeof walletsData === 'object' && walletsData.secretKey) 
    if (typeof walletsData === 'object' && walletsData.secretKey) {
        const secretKey = bs58.decode(walletsData.secretKey);
        return [Keypair.fromSecretKey(secretKey)]; // Wrap it in an array
    }
    // If the file format is invalid, throw an error
    throw new Error('Invalid format in payers.json. Expected an array or a single keypair object.');
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

    let transactionSent = false;
    let retries = 5;

    while (retries > 0 && !transactionSent) {
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
            const message = new TransactionMessage({
                payerKey: payerWallet.publicKey, // Set payerKey to the random payer wallet
                instructions: [createLookupInstruction, extendLookupInstruction],
                recentBlockhash: blockhash,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([payerWallet, sourceWallet]);

            // Send the transaction and immediately wait for confirmation
            console.log('Sending transaction...');
            const signature = await connection.sendTransaction(transaction, {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });
            console.log(`Transaction sent: ${signature}`);

            // Real-time confirmation using onSignature
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Transaction confirmation timed out.'));
                }, 30_000); // 30-second timeout

                connection.onSignature(
                    signature, // Use signature directly here
                    (result) => {
                        clearTimeout(timeout);
                        if (result.err) {
                            reject(new Error('Transaction failed.'));
                        } else {
                            resolve(result);
                        }
                    },
                    'confirmed' // Use a faster commitment level
                );
            });

            console.log(`Transaction finalized: ${signature}`);
            transactionSent = true;
        } catch (error) {
            console.error('Error during ALT creation:', error);
            retries--;

            if (error instanceof Error && error.message.includes('not a recent slot')) {
                slot = await connection.getSlot();
                console.log(`Updated slot to ${slot}. Retrying...`);
            } else {
                throw error;
            }
        }
    }

    if (!transactionSent) {
        throw new Error('Failed to create and extend Address Lookup Table after retries.');
    }

    console.log(`Address Lookup Table created and extended at: ${lookupTableAddress.toBase58()}`);

    await delay(5000); // Shortened delay for propagation

    // Step 2: Fetch and Use Address Lookup Table
    console.log("Fetching Address Lookup Table...");
    const lookupTableAccount = await fetchLookupTable(connection, lookupTableAddress, 10, 500);

    if (!lookupTableAccount || !lookupTableAccount.key) {
        throw new Error('Failed to fetch or retrieve the Address Lookup Table account.');
    }
    console.log(`Fetched Address Lookup Table: ${lookupTableAccount.key.toBase58()}`);

    // Step 3: Create and Log Transaction Sizes (With and Without ALT)
    const transferInstructions = recipients.map((recipient) =>
        SystemProgram.transfer({
            fromPubkey: sourceWallet.publicKey,
            toPubkey: recipient,
            lamports: AMOUNT_TO_SEND_LAMPORTS,
        })
    );

    const { blockhash } = await connection.getLatestBlockhash('finalized');

    // Transaction WITHOUT ALT
    const messageWithoutALT = new TransactionMessage({
        payerKey: payerWallet.publicKey, // Use payerWallet for gas fees
        instructions: transferInstructions,
        recentBlockhash: blockhash,
    }).compileToV0Message();

    const transactionWithoutALT = new VersionedTransaction(messageWithoutALT);
    transactionWithoutALT.sign([payerWallet, sourceWallet]);

    const serializedTransactionWithoutALT = transactionWithoutALT.serialize();
    console.log(`Transaction size WITHOUT ALT: ${serializedTransactionWithoutALT.length} bytes`);

    // Transaction WITH ALT
    const packedMessage = new TransactionMessage({
        payerKey: payerWallet.publicKey, // Use payerWallet for gas fees
        instructions: transferInstructions,
        recentBlockhash: blockhash,
    }).compileToV0Message([lookupTableAccount]);

    const packedTransaction = new VersionedTransaction(packedMessage);
    packedTransaction.sign([payerWallet, sourceWallet]);

    const serializedTransactionWithALT = packedTransaction.serialize();
    console.log(`Transaction size WITH ALT: ${serializedTransactionWithALT.length} bytes`);

    // Send packed transaction with ALT
    try {
        const packedSignature = await connection.sendTransaction(packedTransaction, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });

        console.log(`Packed transaction sent with signature: ${packedSignature}`);
    } catch (error) {
        console.error('Failed to send packed transaction:', error);
    }
};

main().catch((error) => console.error('Error in script execution:', error));
