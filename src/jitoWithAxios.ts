import { Commitment, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import base58 from "bs58";
import axios, { AxiosError } from "axios";
import 'dotenv/config'; // Import dotenv to load .env variables

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || "";
const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT || "";
const JITO_FEE = Number(process.env.JITO_FEE || 0);
const COMMITMENT_LEVEL = process.env.COMMITMENT_LEVEL || "confirmed";

const solanaConnection = new Connection(HELIUS_RPC_URL, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

// Helper: Query bundle statuses
const getBundleStatuses = async (bundleId: string) => {
  const JITO_GET_BUNDLE_STATUS_URL = "https://slc.mainnet.block-engine.jito.wtf/api/v1/bundles";
  try {
    console.log(`Checking status of bundle ID: ${bundleId}`);
    const response = await axios.post(JITO_GET_BUNDLE_STATUS_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "getBundleStatuses",
      params: [[bundleId]],
    });

    console.log("Bundle Status Response:", JSON.stringify(response.data, null, 2));
    return response.data.result?.value?.[0]; // Return the first bundle status (if found)
  } catch (error) {
    console.error("Error fetching bundle status:", error.response?.data || error.message);
    return null;
  }
};

export const jitoWithAxios = async (
  transactions: VersionedTransaction[], 
  payer: Keypair,
  checkBundleStatus = true // Optional: Check bundle status after submission
) => {
  console.log("Starting Jito transaction execution...");
  const tipAccounts = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  ];
  const jitoFeeWallet = new PublicKey(tipAccounts[Math.floor(tipAccounts.length * Math.random())]);

  console.log(`Selected Jito fee wallet: ${jitoFeeWallet.toBase58()}`);
  console.log(`Calculated fee: ${JITO_FEE / LAMPORTS_PER_SOL} SOL`);

  try {
    const latestBlockhash = await solanaConnection.getLatestBlockhash();
    const jitTipTxFeeMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: jitoFeeWallet,
          lamports: JITO_FEE,
        }),
      ],
    }).compileToV0Message();

    const jitoFeeTx = new VersionedTransaction(jitTipTxFeeMessage);
    jitoFeeTx.sign([payer]);

    const serializedjitoFeeTx = base58.encode(jitoFeeTx.serialize());
    const serializedTransactions = [serializedjitoFeeTx];
    for (let i = 0; i < transactions.length; i++) {
      const serializedTransaction = base58.encode(transactions[i].serialize());
      serializedTransactions.push(serializedTransaction);
    }

    const JITO_BUNDLE_URL = "https://slc.mainnet.block-engine.jito.wtf/api/v1/bundles";

    console.log("Sending transactions to Jito...");
    const response = await axios.post(JITO_BUNDLE_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [serializedTransactions, { encoding: "base58" }],
    });

    console.log("Response from Jito:", response.data);
    const bundleId = response.data?.result;

    if (!bundleId) {
      console.error("⚠️ Failed to retrieve bundle ID.");
      return { confirmed: false, bundleId: null };
    }

    console.log(`✅ Jito bundle submitted successfully. 🌟 Bundle ID: ${bundleId}`);

    // Confirm the tip transaction
    const jitoTxsignature = base58.encode(jitoFeeTx.signatures[0]);
    const confirmation = await solanaConnection.confirmTransaction(
      {
        signature: jitoTxsignature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      COMMITMENT_LEVEL as Commitment
    );

    console.log("Confirmation Response:", confirmation);
    if (checkBundleStatus) {
      const bundleStatus = await getBundleStatuses(bundleId);
      return { confirmed: !confirmation.value.err, bundleId, bundleStatus };
    }

    return { confirmed: !confirmation.value.err, bundleId };
  } catch (error) {
    console.error("Error during transaction execution:", error);
    return { confirmed: false, bundleId: null };
  }
};
