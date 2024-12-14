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
    TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// Load environment variables
dotenv.config();
const heliusRpcUrl = process.env.HELIUS_RPC_URL;
if (!heliusRpcUrl) {
    throw new Error("HELIUS_RPC_URL is not defined in the .env file.");
}

// Paths
const walletsPath = path.join(__dirname, '.keys', 'launchers.json');
const payersPath = path.join(__dirname, '.keys', 'payers.json');
const destinationWalletPath = path.join(__dirname, '.keys', 'DevBag.json');

// Constants
const MAX_WALLETS_PER_TRANSACTION = 6; // Batch size to avoid oversized transactions
const RENT_EXEMPT_MINIMUM = 2_039_280; // Rent-exempt minimum balance in lamports
const TRANSACTION_FEE = 5_000;        // Transaction fee estimate in lamports
const SEND_FIXED_AMOUNT = null;       // Set a fixed amount (e.g., 1_000_000_000 for 1 SOL), or `null` to send all available

// Utility functions
function loadWallets(filePath: string): Keypair[] {
    try {
        // Ensure the file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`Wallet file not found at path: ${filePath}`);
        }

        // Read and parse the file
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        if (!fileContent.trim()) {
            throw new Error(`File at ${filePath} is empty.`);
        }

        const walletsData = JSON.parse(fileContent);

        // Handle both single object and array cases
        if (Array.isArray(walletsData)) {
            console.log(`Parsed wallets file as an array (${walletsData.length} entries).`);
            return walletsData.map((wallet: { secretKey: string }) => {
                if (!wallet.secretKey) {
                    throw new Error(`Missing 'secretKey' field in wallet entry: ${JSON.stringify(wallet)}`);
                }
                const secretKey = bs58.decode(wallet.secretKey);
                return Keypair.fromSecretKey(secretKey);
            });
        } else if (typeof walletsData === 'object' && walletsData.secretKey) {
            console.log(`Parsed wallets file as a single object.`);
            const secretKey = bs58.decode(walletsData.secretKey);
            return [Keypair.fromSecretKey(secretKey)];
        } else {
            throw new Error(
                `Invalid format in ${filePath}. Expected an array or an object with a 'secretKey' field.`
            );
        }
    } catch (error) {
        console.error(`Error loading wallets from ${filePath}:`, error);
        throw error;
    }
}

const loadKeypair = (filePath: string): Keypair => {
    const walletData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const secretKey = bs58.decode(walletData.secretKey);
    return Keypair.fromSecretKey(secretKey);
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
    delayMs = 2000
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

// Batch utility
function batchArray<T>(array: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < array.length; i += batchSize) {
        batches.push(array.slice(i, i + batchSize));
    }
    return batches;
}

// Simulate transaction and get logs
async function simulateAndGetLogs(
    connection: Connection,
    transaction: VersionedTransaction
): Promise<void> {
    try {
        const { value } = await connection.simulateTransaction(transaction);
        if (value.err) {
            console.error('Simulation failed with error:', value.err);
        }

        if (value.logs) {
            console.log('Simulation logs:');
            value.logs.forEach((log) => console.log(log));
        } else {
            console.log('No logs were returned from simulation.');
        }
    } catch (error) {
        console.error('Failed to simulate transaction:', error);
    }
}

(async () => {
    const connection = new Connection(heliusRpcUrl, 'confirmed');
    const destinationWallet = loadKeypair(destinationWalletPath);
    const wallets = loadWallets(walletsPath);
    const payers = loadWallets(payersPath);

    const payerWallet = getRandomPayer(payers);

    console.log(`Destination wallet: ${destinationWallet.publicKey.toBase58()}`);
    console.log(`Randomly selected payer wallet: ${payerWallet.publicKey.toBase58()}`);
    console.log(`Loaded ${wallets.length} wallets.`);

    // Step 1: Create and Extend Address Lookup Table
    let slot = await connection.getSlot();
    const [createLookupInstruction, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
        authority: payerWallet.publicKey,
        payer: payerWallet.publicKey,
        recentSlot: slot,
    });

    const extendLookupInstruction = AddressLookupTableProgram.extendLookupTable({
        lookupTable: lookupTableAddress,
        payer: payerWallet.publicKey,
        authority: payerWallet.publicKey,
        addresses: wallets.map((wallet) => wallet.publicKey),
    });

    console.log(`Address Lookup Table to be created: ${lookupTableAddress.toBase58()}`);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    const createMessage = new TransactionMessage({
        payerKey: payerWallet.publicKey,
        instructions: [createLookupInstruction, extendLookupInstruction],
        recentBlockhash: blockhash,
    }).compileToV0Message();

    const createTransaction = new VersionedTransaction(createMessage);
    createTransaction.sign([payerWallet]);

    try {
        const createSignature = await connection.sendTransaction(createTransaction, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });
        console.log(`Transaction sent: ${createSignature}`);
        await connection.confirmTransaction(
            {
                signature: createSignature,
                blockhash,
                lastValidBlockHeight,
            },
            'finalized'
        );
        console.log(`Created and extended Address Lookup Table: ${lookupTableAddress.toBase58()}`);
    } catch (error) {
        console.error('Error sending transaction:', error);
        return;
    }

    const lookupTableAccount = await fetchLookupTable(connection, lookupTableAddress, 10, 2000);
    if (!lookupTableAccount || !lookupTableAccount.key) {
        throw new Error('Failed to fetch the Address Lookup Table account.');
    }
    console.log(`Fetched Address Lookup Table: ${lookupTableAccount.key.toBase58()}`);

    // Step 2: Prepare Transfer Instructions
    const transferInstructions: TransactionInstruction[] = [];
    const signers: Keypair[] = [];

    for (const wallet of wallets) {
        try {
            const balance = await connection.getBalance(wallet.publicKey);
            console.log(`Wallet ${wallet.publicKey.toBase58()} has balance: ${balance} lamports`);

            if (balance <= RENT_EXEMPT_MINIMUM + TRANSACTION_FEE) {
                console.log(`Wallet ${wallet.publicKey.toBase58()} has insufficient balance. Skipping.`);
                continue;
            }

            let transferAmount: number;

            if (SEND_FIXED_AMOUNT && balance >= SEND_FIXED_AMOUNT + RENT_EXEMPT_MINIMUM + TRANSACTION_FEE) {
                // Send the fixed amount if specified and balance is sufficient
                transferAmount = SEND_FIXED_AMOUNT;
                console.log(`Wallet ${wallet.publicKey.toBase58()} will send a fixed amount of ${transferAmount} lamports.`);
            } else {
                // Fallback to default behavior: send all except rent and transaction fee
                transferAmount = balance - RENT_EXEMPT_MINIMUM - TRANSACTION_FEE;
                console.log(`Wallet ${wallet.publicKey.toBase58()} will send ${transferAmount} lamports (remaining rent + fee retained).`);
            }

            // Create the transfer instruction
            const transferInstruction = SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: destinationWallet.publicKey,
                lamports: transferAmount,
            });

            transferInstructions.push(transferInstruction);
            signers.push(wallet); // Add wallet to signers
        } catch (error) {
            console.error(`Error preparing transfer for wallet ${wallet.publicKey.toBase58()}:`, error);
        }
    }

    if (transferInstructions.length === 0) {
        console.log('No valid transfers to process.');
        return;
    }

    const instructionBatches = batchArray(transferInstructions, MAX_WALLETS_PER_TRANSACTION);
    const signerBatches = batchArray(signers, MAX_WALLETS_PER_TRANSACTION);

    console.log(`Processing ${instructionBatches.length} transactions (batches of ${MAX_WALLETS_PER_TRANSACTION}).`);

    for (let i = 0; i < instructionBatches.length; i++) {
        const batchInstructions = instructionBatches[i];
        const batchSigners = signerBatches[i];

        const { blockhash: batchBlockhash, lastValidBlockHeight: batchLastValidBlockHeight } =
            await connection.getLatestBlockhash('finalized');

        const batchMessage = new TransactionMessage({
            payerKey: payerWallet.publicKey,
            instructions: batchInstructions,
            recentBlockhash: batchBlockhash,
        }).compileToV0Message([lookupTableAccount]);

        const batchTransaction = new VersionedTransaction(batchMessage);
        batchTransaction.sign([payerWallet, ...batchSigners]);

        const transactionSize = batchTransaction.serialize().length;
        console.log(`Batch ${i + 1}: Transaction size is ${transactionSize} bytes`);

        if (transactionSize > 1232) {
            console.error('Transaction size exceeds the maximum allowed limit. Skipping this batch.');
            continue;
        }

        try {
            const batchSignature = await connection.sendTransaction(batchTransaction, {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });
            console.log(`Batch ${i + 1}/${instructionBatches.length} sent with signature: ${batchSignature}`);
        } catch (error) {
            console.error(`Failed to send batch ${i + 1}/${instructionBatches.length}:`, error);

            console.log(`Simulating batch ${i + 1} for debug logs...`);
            await simulateAndGetLogs(connection, batchTransaction);
        }
    }
})();
