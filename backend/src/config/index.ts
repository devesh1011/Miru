import dotenv from "dotenv";

dotenv.config();

export const config = {
  // Sui Network
  sui: {
    network: process.env.SUI_NETWORK || "testnet",
    rpcUrl: process.env.SUI_RPC_URL || "https://fullnode.testnet.sui.io:443",
    wsUrl: process.env.SUI_WS_URL || "wss://fullnode.testnet.sui.io:443",
    // DeepBook Package ID (for event filtering)
    deepBookPackageId:
      process.env.DEEPBOOK_PACKAGE_ID ||
      "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809",
  },

  // DeepBook
  deepbook: {
    packageId:
      process.env.DEEPBOOK_PACKAGE_ID ||
      "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809",
    registryId: process.env.DEEPBOOK_REGISTRY_ID || "0x0",
  },

  // DeepMirror Contracts
  contracts: {
    mirrorPackageId: process.env.MIRROR_PACKAGE_ID || "0x0",
    protocolConfigId: process.env.PROTOCOL_CONFIG_ID || "0x0",
  },

  // Telegram Bot
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
  },

  // Database (SQLite for MVP, easy to swap later)
  database: {
    sqlitePath: process.env.DB_PATH || "./deepmirror.db",
    // Legacy PostgreSQL fields (kept for future migration)
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    name: process.env.DB_NAME || "deepmirror",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
  },

  // App
  app: {
    port: parseInt(process.env.PORT || "3000"),
    environment: process.env.NODE_ENV || "development",
  },

  // Wallet (for backend operations)
  wallet: {
    privateKey: process.env.WALLET_PRIVATE_KEY || "",
  },
} as const;
