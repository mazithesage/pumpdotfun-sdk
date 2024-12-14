import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import 'dotenv/config';

const BLOCKENGINE_URL = process.env.BLOCKENGINE_URL || "";

const main = async () => {
  const search = searcherClient(BLOCKENGINE_URL);

  search.onBundleResult(
    (result: any) => {
      console.log("✅ Raw Bundle Result:", JSON.stringify(result, null, 2));
    },
    (error: any) => {
      console.error("❌ Stream Error in onBundleResult:", error);
    }
  );

  console.log("Waiting for bundle results...");
};

main().catch(console.error);
