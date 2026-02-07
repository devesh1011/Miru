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

  // Database (Supabase PostgreSQL)
  database: {
    supabaseUrl:
      process.env.SUPABASE_URL || "https://tycbdxeomrsiyrvdlmgx.supabase.co",
    supabaseKey:
      process.env.SUPABASE_KEY ||
      "sb_publishable_EzSF9AVp6CyEA0Q6VxyhvA_XfyzIDEl",
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

  // zkLogin (non-custodial)
  zkLogin: {
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    redirectUrl:
      process.env.ZKLOGIN_REDIRECT_URL ||
      "https://miru-zklogin.vercel.app/callback",
    proverUrl:
      process.env.ZKLOGIN_PROVER_URL || "https://prover.mystenlabs.com/v1",
    masterSeed: process.env.ZKLOGIN_MASTER_SEED || "",
    maxEpochOffset: parseInt(process.env.ZKLOGIN_MAX_EPOCH_OFFSET || "2"),
  },
} as const;
