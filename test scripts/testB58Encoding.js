const bs58 = require("bs58");
const { Keypair } = require("@solana/web3.js");

// Input your secret key array here
const secretKeyArray = [
    [216,201,57,90,3,164,160,234,169,60,164,220,32,99,237,19,151,99,85,18,132,28,109,178,82,134,84,213,16,162,120,213,203,174,127,65,79,29,213,168,226,147,152,3,56,169,49,207,32,237,3,119,88,14,240,243,97,90,5,58,27,149,70,251]
];

try {
  // Convert the input array to a Keypair
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

  // Get the Base58-encoded private key
  const privateKeyB58 = bs58.encode(Uint8Array.from(keypair.secretKey));

  console.log("Public Key (Base58):", keypair.publicKey.toBase58());
  console.log("Private Key (Base58):", privateKeyB58);
} catch (err) {
  console.error("Error:", err.message);
}
