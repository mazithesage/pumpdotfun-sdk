// Jito Bundling part
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import base58 from "bs58";
import { SearcherClient, searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import { isError } from "jito-ts/dist/sdk/block-engine/utils";

import 'dotenv/config';
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || "";
const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT || "";
const BLOCKENGINE_URL = process.env.BLOCKENGINE_URL || "";
const JITO_AUTH_KEYPAIR = process.env.JITO_AUTH_KEYPAIR || "";
const JITO_FEE = Number(process.env.JITO_FEE || 0);

const connection = new Connection(HELIUS_RPC_URL, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export async function bundle(txs: VersionedTransaction[], keypair: Keypair) {
  try {
    const txNum = Math.ceil(txs.length / 5);
    let successNum = 0;
    console.log(`Starting Jito bundling process with ${txs.length} transactions...`);
    console.log(`Splitting into ${txNum} bundles with a maximum of 5 transactions per bundle.`);

    for (let i = 0; i < txNum; i++) {
      const upperIndex = (i + 1) * 5;
      const downIndex = i * 5;
      const newTxs: VersionedTransaction[] = [];
      for (let j = downIndex; j < upperIndex; j++) {
        if (txs[j]) newTxs.push(txs[j]);
      }
      console.log(`Submitting bundle ${i + 1} with ${newTxs.length} transactions to Jito...`);

      const success = await bull_dozer(newTxs, keypair);
      if (success) {
        console.log(`Bundle ${i + 1} successfully submitted and accepted by Jito.`);
        successNum++;
      } else {
        console.error(`Bundle ${i + 1} submission failed or was rejected by Jito.`);
      }
    }

    console.log(`Jito bundling completed: ${successNum}/${txNum} bundles accepted.`);
    return successNum === txNum;
  } catch (error) {
    console.error("Error during Jito bundling process:", error);
    return false;
  }
}

export async function bull_dozer(txs: VersionedTransaction[], keypair: Keypair) {
  try {
    const bundleTransactionLimit = 5;
    const search =
      JITO_AUTH_KEYPAIR && JITO_AUTH_KEYPAIR.trim().length > 0
        ? searcherClient(BLOCKENGINE_URL, Keypair.fromSecretKey(base58.decode(JITO_AUTH_KEYPAIR)))
        : searcherClient(BLOCKENGINE_URL); // Use public mode if no auth key is provided

    console.log("Building bundle for Jito submission...");
    const maybeBundle = await build_bundle(search, bundleTransactionLimit, txs, keypair);
    if (maybeBundle) {
      console.log("Bundle built successfully. Awaiting result...");
    } else {
      console.error("Failed to build the bundle.");
      return false;
    }
    const bundleResult = await onBundleResult(search);
    if (bundleResult > 0) {
      console.log(`Bundle accepted by Jito with result code: ${bundleResult}`);
      return true;
    } else {
      console.error(`Bundle rejected by Jito with result code: ${bundleResult}`);
      return false;
    }
  } catch (error) {
    console.error("Error during Jito bundling (bull_dozer):", error);
    return false;
  }
}

async function build_bundle(
  search: SearcherClient,
  bundleTransactionLimit: number,
  txs: VersionedTransaction[],
  keypair: Keypair
) {
  try {
    console.log("Fetching tip accounts...");
    const accounts = await search.getTipAccounts();
    const _tipAccount = accounts[Math.min(Math.floor(Math.random() * accounts.length), 3)];
    const tipAccount = new PublicKey(_tipAccount);
    console.log(`Selected tip account: ${tipAccount.toBase58()}`);

    console.log("Building Jito bundle...");
    const bund = new Bundle([], bundleTransactionLimit);
    const resp = await connection.getLatestBlockhash("processed");
    bund.addTransactions(...txs);

    const maybeBundle = bund.addTipTx(keypair, JITO_FEE, tipAccount, resp.blockhash);

    if (isError(maybeBundle)) {
      console.error("Error while adding tip transaction to bundle:", maybeBundle);
      throw maybeBundle;
    }
    console.log("Sending Jito bundle...");
    await search.sendBundle(maybeBundle);

    return maybeBundle;
  } catch (error) {
    console.error("Error during bundle building:", error);
    throw error;
  }
}

export const onBundleResult = (c: SearcherClient): Promise<number> => {
  let first = 0; // Tracks accepted bundles
  let isResolved = false; // Prevents multiple resolutions of the Promise

  return new Promise((resolve) => {
    // Set a timeout to reject the promise if no bundle is accepted within 30 seconds
    setTimeout(() => {
      console.log("Timeout: No bundle accepted within 30 seconds.");
      resolve(first);
      isResolved = true;
    }, 30000);

    // Subscribe to bundle results
    c.onBundleResult(
      (result: any) => {
        // Log the entire raw response from the server
        console.log("BundleResult received from server:", JSON.stringify(result, null, 2));

        if (isResolved) return first;
        const isAccepted = result.accepted;
        const isRejected = result.rejected;

        if (isAccepted) {
          console.log("✅ Bundle accepted");
          console.log(`Bundle ID: ${result.bundleId}`);
          console.log(`Accepted Slot: ${result.accepted.slot}`);
          first += 1; // Increment the accepted count
          isResolved = true;
          resolve(first); // Resolve the promise when a bundle is accepted
        } else if (isRejected) {
          console.error("❌ Bundle rejected");
          console.error(`Bundle ID: ${result.bundleId}`);
          console.error(`Reason for rejection: ${result.rejected.reason}`); // Example key, depends on API
        } else {
          console.log("⚠️ Bundle in unknown state:");
          console.log(result);
        }
      },
      (e: any) => {
        // Log stream errors
        console.error("Error in onBundleResult:", e);
      }
    );
  });
};
