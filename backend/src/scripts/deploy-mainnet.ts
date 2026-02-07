import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTRACTS_DIR = path.join(__dirname, "../../../contracts");
const ENV_FILE = path.join(__dirname, "../../../backend/.env");

interface DeploymentResult {
  packageId: string;
  protocolConfigId: string;
  upgradeCapId: string;
  transactionDigest: string;
}

function checkPrerequisites() {
  console.log("🔍 Checking prerequisites...\n");

  try {
    // Check Sui CLI is installed
    execSync("sui --version", { stdio: "pipe" });
    console.log("✅ Sui CLI installed");
  } catch {
    console.error(
      "❌ Sui CLI not found. Install from: https://docs.sui.io/build/install",
    );
    process.exit(1);
  }

  try {
    // Check current network
    const activeEnv = execSync("sui client active-env", {
      encoding: "utf-8",
    }).trim();
    if (activeEnv !== "mainnet") {
      console.log(`⚠️  Current network: ${activeEnv}`);
      console.log("   Switch to mainnet: sui client switch --env mainnet\n");

      const readline = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      readline.question("Continue anyway? (y/N): ", (answer: string) => {
        readline.close();
        if (answer.toLowerCase() !== "y") {
          console.log("Deployment cancelled.");
          process.exit(0);
        }
      });
    } else {
      console.log("✅ Network: mainnet");
    }
  } catch (error) {
    console.error("❌ Could not determine active network");
    process.exit(1);
  }

  try {
    // Check wallet balance
    const balance = execSync("sui client gas", { encoding: "utf-8" });
    console.log("✅ Wallet connected\n");
  } catch {
    console.error("❌ No active wallet found");
    process.exit(1);
  }
}

function deployContract(): DeploymentResult {
  console.log("🚀 Deploying contract to mainnet...\n");

  try {
    // Run sui client publish
    const output = execSync(
      `sui client publish --gas-budget 100000000 --json`,
      {
        cwd: CONTRACTS_DIR,
        encoding: "utf-8",
      },
    );

    const result = JSON.parse(output);

    // Extract package ID from creation events
    const packageId = result.effects?.created?.find(
      (obj: any) => obj.owner === "Immutable",
    )?.reference?.objectId;

    if (!packageId) {
      console.error("❌ Failed to extract package ID from deployment");
      console.log("Raw output:", JSON.stringify(result, null, 2));
      process.exit(1);
    }

    // Extract ProtocolConfig object (shared object created during init)
    const protocolConfigId = result.effects?.created?.find(
      (obj: any) => obj.owner?.Shared,
    )?.reference?.objectId;

    // Extract UpgradeCap object
    const upgradeCapId = result.effects?.created?.find(
      (obj: any) =>
        obj.owner?.AddressOwner &&
        result.objectChanges?.find(
          (change: any) =>
            change.objectId === obj.reference.objectId &&
            change.objectType?.includes("UpgradeCap"),
        ),
    )?.reference?.objectId;

    const transactionDigest = result.digest;

    console.log("✅ Contract deployed successfully!\n");
    console.log("📦 Deployment Details:");
    console.log(`   Package ID:        ${packageId}`);
    console.log(`   Protocol Config:   ${protocolConfigId || "N/A"}`);
    console.log(`   Upgrade Cap:       ${upgradeCapId || "N/A"}`);
    console.log(`   Transaction:       ${transactionDigest}`);
    console.log(
      `   Explorer:          https://suiscan.xyz/mainnet/tx/${transactionDigest}\n`,
    );

    return {
      packageId,
      protocolConfigId: protocolConfigId || "0x0",
      upgradeCapId: upgradeCapId || "0x0",
      transactionDigest,
    };
  } catch (error: any) {
    console.error("❌ Deployment failed:");
    console.error(error.message);
    process.exit(1);
  }
}

function updateEnvFile(deployment: DeploymentResult) {
  console.log("📝 Updating .env file...\n");

  const envExample = `
# Sui Network Configuration
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_WS_URL=wss://fullnode.mainnet.sui.io:443

# DeepBook V3 (Mainnet)
DEEPBOOK_PACKAGE_ID=0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809
DEEPBOOK_REGISTRY_ID=0x0

# DeepMirror Contract (Mainnet)
MIRROR_PACKAGE_ID=${deployment.packageId}
PROTOCOL_CONFIG_ID=${deployment.protocolConfigId}
UPGRADE_CAP_ID=${deployment.upgradeCapId}

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
`;

  console.log("Add these to your .env file:");
  console.log("─".repeat(60));
  console.log(envExample);
  console.log("─".repeat(60));
  console.log("\n✅ Deployment complete!\n");
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   DeepMirror Mainnet Deployment Script      ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  checkPrerequisites();

  console.log("\n⚠️  WARNING: You are about to deploy to MAINNET");
  console.log("   This will consume real SUI tokens (~0.01 SUI)\n");

  // Deploy contract
  const deployment = deployContract();

  // Show env configuration
  updateEnvFile(deployment);

  console.log("📋 Next Steps:");
  console.log("   1. Update your .env file with the values above");
  console.log("   2. Restart your bot: npm run dev");
  console.log("   3. Create your first position on mainnet!");
  console.log("\n🎉 Ready to copy trade on Sui mainnet!\n");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
