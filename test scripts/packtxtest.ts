import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { Connection, Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58'; // Import Base58 decoding library

// Load environment variables
dotenv.config();
const heliusRpcUrl = process.env.HELIUS_RPC_URL;

if (!heliusRpcUrl) {
    throw new Error("HELIUS_RPC_URL is not defined in the .env file.");
}

// Paths to key files
const launchersPath = 'C:\\Users\\moo\\Desktop\\pumpfun\\scripts\\pumpdotfun-sdk\\.keys\\launchers.json';
const devBagPath = 'C:\\Users\\moo\\Desktop\\pumpfun\\scripts\\pumpdotfun-sdk\\.keys\\DevBag.json';

// Load keypair from Base58-encoded secret key
function loadKeypairFromSecretKey(secretKey: string): Keypair {
    const secretKeyDecoded = bs58.decode(secretKey);
    return Keypair.fromSecretKey(secretKeyDecoded);
}

// Load all launcher wallets
function loadLaunchers(path: string): Keypair[] {
    const launchersData = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return launchersData.map((launcher: { secretKey: string; publicKey: string }) =>
        loadKeypairFromSecretKey(launcher.secretKey)
    );
}

(async () => {
    // Connection to Solana cluster via Helius RPC
    const connection = new Connection(heliusRpcUrl, 'confirmed');

    // Load wallets
    const launcherWallets = loadLaunchers(launchersPath);
    const devBagData = JSON.parse(fs.readFileSync(devBagPath, 'utf-8'));
    const devBagWallet = loadKeypairFromSecretKey(devBagData.secretKey);

    if (launcherWallets.length === 0) {
        throw new Error("No launcher wallets loaded.");
    }

    // Define the fee payer (e.g., first launcher wallet)
    const feePayer = launcherWallets[0];

    console.log('Loaded wallets. Launchers:', launcherWallets.length, 'DevBag:', devBagWallet.publicKey.toBase58());

    // Define the amount to transfer (0.1 SOL = 100,000,000 lamports)
    const transferAmount = 0.01 * 1e9;

    // Create a single transaction
    const transaction = new Transaction();
    transaction.feePayer = feePayer.publicKey; // Set the fee payer

    // Add a transfer instruction for each launcher wallet
    for (const launcherWallet of launcherWallets) {
        transaction.add(
            SystemProgram.transfer({
                fromPubkey: launcherWallet.publicKey,
                toPubkey: devBagWallet.publicKey,
                lamports: transferAmount,
            })
        );
    }

    // Fetch and set recent blockhash
    try {
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;

        // Calculate and log transaction size
        const serializedTransaction = transaction.serialize({ requireAllSignatures: false });
        console.log(`Transaction size: ${serializedTransaction.length} bytes`);

        // Sign the transaction with all launcher wallets
        const signers = [feePayer, ...launcherWallets]; // Fee payer and launcher wallets must sign
        const signature = await connection.sendTransaction(transaction, signers, { skipPreflight: false, preflightCommitment: 'confirmed' });
        console.log(`Transaction successful with signature: ${signature}`);
    } catch (error) {
        console.error('Transaction failed:', error);
    }
})();
