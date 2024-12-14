const express = require("express");
const fs = require("fs");
const path = require("path");
const bs58 = require("bs58").default;
const { Keypair, Connection } = require("@solana/web3.js");
const http = require("http");
const { Server } = require("socket.io");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3003;
const walletDir = path.resolve(__dirname, "../.keys");
const configFilePath = path.resolve(__dirname, "../config.json");
const backlogsDir = path.join(walletDir, "backlogs");

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const connection = new Connection(RPC_URL);
console.log(`RPC URL: ${RPC_URL}`);
console.log(`Wallet Directory: ${walletDir}`);
console.log(`Config File Path: ${configFilePath}`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../wallet")));

const updateConfig = () => {
    console.log("Updating config.json...");
    try {
        const launchersPath = path.join(walletDir, "launchers.json");
        if (!fs.existsSync(launchersPath)) {
            console.log("launchers.json not found. Skipping config update.");
            return;
        }

        const launchers = JSON.parse(fs.readFileSync(launchersPath, "utf-8"));
        const config = fs.existsSync(configFilePath)
            ? JSON.parse(fs.readFileSync(configFilePath, "utf-8"))
            : { launcherWalletSolAmounts: {} };

        const launcherWalletSolAmounts = config.launcherWalletSolAmounts || {};

        launchers.forEach((launcher) => {
            if (!launcherWalletSolAmounts[launcher.publicKey]) {
                launcherWalletSolAmounts[launcher.publicKey] = null;
            }
        });

        for (const publicKey in launcherWalletSolAmounts) {
            if (!launchers.some((launcher) => launcher.publicKey === publicKey)) {
                delete launcherWalletSolAmounts[publicKey];
            }
        }

        fs.writeFileSync(
            configFilePath,
            JSON.stringify({ ...config, launcherWalletSolAmounts }, null, 2)
        );
        console.log("config.json updated successfully.");
    } catch (error) {
        console.error("Failed to update config.json:", error.message);
    }
};

app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>BBAzn's Rug Army</title>
        <link rel="stylesheet" href="/style.css">
        <script src="/socket.io/socket.io.js"></script>
    </head>
    <body>
        <h1>BBAzn's Rug Army</h1>
        <div class="button-container">
            <button id="generate-wallet-btn">Generate Wallets</button>
        </div>
        <div class="modal" id="generate-wallet-modal">
            <div class="modal-content">
                <h2>Generate Wallets</h2>
                <form id="generate-form">
                    <label for="fileName">Battalion Name:</label>
                    <input type="text" id="fileName" name="fileName" required>
                    <label for="numWallets">Number of Wallets:</label>
                    <input type="number" id="numWallets" name="numWallets" min="1" required>
                    <label>
                        <input type="checkbox" id="overwriteLaunchers" name="overwriteLaunchers">
                        Overwrite launchers.json
                    </label>
                    <button type="submit">Generate</button>
                    <button type="button" id="close-modal-btn">Cancel</button>
                </form>
            </div>
        </div>
        <div id="wallet-container"></div>

        <script>
            const socket = io();

            const modal = document.getElementById("generate-wallet-modal");
            const generateWalletBtn = document.getElementById("generate-wallet-btn");
            const closeModalBtn = document.getElementById("close-modal-btn");

            generateWalletBtn.addEventListener("click", () => {
                modal.style.display = "flex";
            });

            closeModalBtn.addEventListener("click", () => {
                modal.style.display = "none";
            });

            document.getElementById("generate-form").addEventListener("submit", async (e) => {
                e.preventDefault();
                const fileName = document.getElementById("fileName").value;
                const numWallets = document.getElementById("numWallets").value;
                const overwriteLaunchers = document.getElementById("overwriteLaunchers").checked;

                const response = await fetch("/generate-wallets", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fileName, numWallets, overwriteLaunchers }),
                });

                const data = await response.json();
                alert(data.message);
                modal.style.display = "none";
                socket.emit("refresh");
            });

            socket.on("update", (walletSections) => {
                const container = document.getElementById("wallet-container");
                container.innerHTML = "";

                walletSections.forEach((section) => {
                    const sectionDiv = document.createElement("div");
                    sectionDiv.className = "section";

                    const title = document.createElement("h2");
                    title.style.color = "#ff6ec7";
                    title.textContent = \`Battalion: \${section.fileName}\`;
                    sectionDiv.appendChild(title);

                    if (section.error) {
                        const error = document.createElement("p");
                        error.style.color = "#ff6ec7";
                        error.textContent = section.error;
                        sectionDiv.appendChild(error);
                    } else {
                        const table = document.createElement("table");
                        const headerRow = \`
                            <tr>
                                <th>Public Key</th>
                                <th>Private Key (Base58)</th>
                                <th>Balance (SOL)</th>
                            </tr>\`;
                        table.innerHTML = headerRow;

                        section.wallets.forEach((wallet) => {
                            const row = document.createElement("tr");
                            row.innerHTML = wallet.error
                                ? \`<td colspan="3" style="color: #ff6ec7;">\${wallet.error}</td>\`
                                : \`
                                    <td>\${wallet.publicKey}</td>
                                    <td>\${wallet.privateKey}</td>
                                    <td>\${wallet.balance}</td>\`;
                            table.appendChild(row);
                        });
                        sectionDiv.appendChild(table);
                    }
                    container.appendChild(sectionDiv);
                });
            });
        </script>
    </body>
    </html>
    `);
});

app.post("/generate-wallets", (req, res) => {
    console.log("Received request to generate wallets.");
    const { fileName, numWallets, overwriteLaunchers } = req.body;

    try {
        const filePath = path.join(walletDir, `${fileName}.json`);

        if (!fs.existsSync(backlogsDir)) {
            console.log("Creating backlogs directory...");
            fs.mkdirSync(backlogsDir, { recursive: true });
        }

        let isOverwriting = false;

        if (fs.existsSync(filePath)) {
            const timestamp = new Date().toISOString().replace(/:/g, "-");
            const backupFilePath = path.join(backlogsDir, `${fileName}-${timestamp}.json`);
            console.log(`Backing up existing file to: ${backupFilePath}`);
            fs.renameSync(filePath, backupFilePath);
            isOverwriting = true;
        }

        // Generate wallets
        let wallets;
        if (parseInt(numWallets, 10) === 1) {
            const keypair = Keypair.generate();
            wallets = {
                secretKey: bs58.encode(Buffer.from(keypair.secretKey)),
                publicKey: keypair.publicKey.toBase58(),
            };
        } else {
            wallets = Array.from({ length: parseInt(numWallets, 10) }, () => {
                const keypair = Keypair.generate();
                return {
                    secretKey: bs58.encode(Buffer.from(keypair.secretKey)),
                    publicKey: keypair.publicKey.toBase58(),
                };
            });
        }

        // Write to file
        fs.writeFileSync(filePath, JSON.stringify(wallets, null, 2));

        // Update launchers.json only if explicitly requested
        if (overwriteLaunchers) {
            console.log("Explicit overwrite flag set. Updating launchers.json...");
            fs.writeFileSync(path.join(walletDir, "launchers.json"), JSON.stringify(wallets, null, 2));
        } else if (isOverwriting) {
            console.log("Skipping update to launchers.json as overwrite flag is not set.");
        }

        updateConfig(); // Update the config file after generating wallets

        res.json({
            message: `Successfully generated ${numWallets} wallet(s) in "${fileName}.json". Backup saved to "${backlogsDir}".`,
        });
    } catch (error) {
        console.error("Error generating wallets:", error.message);
        res.status(500).json({ message: "Failed to generate wallets.", error: error.message });
    }
});
async function fetchWallets() {
    console.log("Fetching wallet details...");
    try {
        const files = fs.readdirSync(walletDir).filter((file) => file.endsWith(".json"));

        return Promise.all(
            files.map(async (file) => {
                try {
                    const keyData = JSON.parse(fs.readFileSync(path.join(walletDir, file), "utf-8"));

                    const wallets = await Promise.all(
                        (Array.isArray(keyData) ? keyData : [keyData]).map(async (wallet) => {
                            try {
                                const keypair = Keypair.fromSecretKey(bs58.decode(wallet.secretKey));
                                const balance = await connection.getBalance(keypair.publicKey, "confirmed");
                                return {
                                    publicKey: wallet.publicKey,
                                    privateKey: wallet.secretKey,
                                    balance: (balance / 1e9).toFixed(2),
                                };
                            } catch (balanceError) {
                                console.error(`Error fetching balance for ${wallet.publicKey}:`, balanceError.message);
                                return { publicKey: wallet.publicKey, privateKey: wallet.secretKey, balance: "Error" };
                            }
                        })
                    );

                    return { fileName: file, wallets };
                } catch (fileError) {
                    console.error(`Error processing file ${file}:`, fileError.message);
                    return { fileName: file, error: "Invalid or corrupted file." };
                }
            })
        );
    } catch (readError) {
        console.error("Error fetching wallets:", readError.message);
        return [];
    }
}

io.on("connection", (socket) => {
    console.log("New client connected.");

    const updateWallets = async () => {
        console.log("Updating wallet information...");
        const walletSections = await fetchWallets();
        updateConfig();
        socket.emit("update", walletSections);
    };

    updateWallets();
    socket.on("refresh", updateWallets);
    socket.on("disconnect", () => {
        console.log("Client disconnected.");
    });
});

server.listen(PORT, () => {
    console.log(`Wallet viewer running at http://localhost:${PORT}`);
    updateConfig();
});
