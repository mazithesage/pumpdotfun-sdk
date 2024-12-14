const bs58 = require("bs58").default;
console.log("Loaded bs58 module:", bs58);

// Test decoding a Base58-encoded string
try {
    const decoded = bs58.decode("[216,201,57,90,3,164,160,234,169,60,164,220,32,99,237,19,151,99,85,18,132,28,109,178,82,134,84,213,16,162,120,213,203,174,127,65,79,29,213,168,226,147,152,3,56,169,49,207,32,237,3,119,88,14,240,243,97,90,5,58,27,149,70,251]

");
    console.log("Decoded Value:", decoded);
} catch (error) {
    console.error("Error decoding Base58:", error.message);
}
