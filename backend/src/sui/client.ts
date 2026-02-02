import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { ClientWithExtensions, SuiClientTypes } from "@mysten/sui/client";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  deepbook,
  type DeepBookClient,
  type BalanceManager,
  testnetCoins,
  mainnetCoins,
  testnetPools,
  mainnetPools,
} from "@mysten/deepbook-v3";
import { config } from "../config/index.js";

/**
 * Extended client type with DeepBook plugin
 */
type DeepBookExtendedClient = ClientWithExtensions<{
  deepbook: DeepBookClient;
}>;

/**
 * SuiService - Manages Sui blockchain client with DeepBook V3 extension
 *
 * Uses the official @mysten/deepbook-v3 SDK extension pattern:
 *   SuiGrpcClient.$extend(deepbook({address, balanceManagers}))
 *
 * Also keeps a SuiJsonRpcClient for event queries (not available on gRPC CoreClient).
 */
export class SuiService {
  private client: DeepBookExtendedClient;
  private jsonRpcClient: SuiJsonRpcClient;
  private keypair: Ed25519Keypair | null = null;
  private network: SuiClientTypes.Network;

  constructor() {
    this.network = config.sui.network === "mainnet" ? "mainnet" : "testnet";
    const rpcUrl =
      config.sui.network === "mainnet"
        ? "https://fullnode.mainnet.sui.io:443"
        : "https://fullnode.testnet.sui.io:443";

    // Initialize keypair if private key is provided
    if (config.wallet.privateKey) {
      const { scheme, secretKey } = decodeSuiPrivateKey(
        config.wallet.privateKey,
      );
      if (scheme === "ED25519") {
        this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
      } else {
        throw new Error(`Unsupported key scheme: ${scheme}`);
      }
    }

    // Create SuiGrpcClient extended with DeepBook V3 plugin
    this.client = this.createExtendedClient(rpcUrl);

    // JSON-RPC client for event queries (queryEvents not on gRPC CoreClient)
    this.jsonRpcClient = new SuiJsonRpcClient({
      url: rpcUrl,
      network: this.network,
    });
  }

  /**
   * Create the extended client with DeepBook plugin
   */
  private createExtendedClient(
    baseUrl: string,
    balanceManagers?: Record<string, BalanceManager>,
  ): DeepBookExtendedClient {
    const address = this.keypair
      ? this.keypair.getPublicKey().toSuiAddress()
      : "0x0";

    return new SuiGrpcClient({ network: this.network, baseUrl }).$extend(
      deepbook({
        address,
        balanceManagers,
        coins: this.network === "mainnet" ? mainnetCoins : testnetCoins,
        pools: this.network === "mainnet" ? mainnetPools : testnetPools,
      }),
    ) as DeepBookExtendedClient;
  }

  /**
   * Get the extended DeepBook client
   */
  getClient(): DeepBookExtendedClient {
    return this.client;
  }

  /**
   * Get the DeepBook sub-client for read operations and transaction builders
   */
  getDeepBook(): DeepBookClient {
    return this.client.deepbook;
  }

  /**
   * Get the JSON-RPC client (for event queries)
   */
  getJsonRpcClient(): SuiJsonRpcClient {
    return this.jsonRpcClient;
  }

  getKeypair(): Ed25519Keypair {
    if (!this.keypair) {
      throw new Error(
        "Keypair not initialized. Set WALLET_PRIVATE_KEY in .env",
      );
    }
    return this.keypair;
  }

  getAddress(): string {
    return this.getKeypair().getPublicKey().toSuiAddress();
  }

  getNetwork(): SuiClientTypes.Network {
    return this.network;
  }

  /**
   * Build and execute a transaction
   */
  async executeTransaction(tx: Transaction): Promise<string> {
    const keypair = this.getKeypair();

    const result = await this.client.core.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      include: {
        effects: true,
      },
    });

    if (result.$kind === "FailedTransaction") {
      throw new Error("Transaction failed");
    }

    return result.Transaction?.digest || "";
  }

  /**
   * Execute transaction and return full result (for object creation etc.)
   */
  async executeTransactionFull(tx: Transaction) {
    const keypair = this.getKeypair();

    const result = await this.client.core.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      include: {
        effects: true,
        objectTypes: true,
        events: true,
      },
    });

    if (result.$kind === "FailedTransaction") {
      throw new Error("Transaction failed");
    }

    return result.Transaction!;
  }

  /**
   * Get SUI balance for an address
   */
  async getBalance(
    address: string,
    coinType: string = "0x2::sui::SUI",
  ): Promise<string> {
    const result = await this.client.core.getBalance({
      owner: address,
      coinType,
    });
    return result.balance.balance;
  }

  /**
   * Get object by ID (returns JSON content)
   */
  async getObject(objectId: string) {
    return this.client.core.getObject({
      objectId,
      include: {
        json: true,
      },
    });
  }

  /**
   * List objects owned by address, optionally filtered by type
   */
  async listOwnedObjects(address: string, type?: string) {
    return this.client.core.listOwnedObjects({
      owner: address,
      type,
      include: {
        json: true,
      },
    });
  }

  /**
   * Query events by type using JSON-RPC client
   * (queryEvents not available on gRPC CoreClient)
   */
  async queryEvents(eventType: string, limit: number = 100) {
    return this.jsonRpcClient.queryEvents({
      query: { MoveEventType: eventType },
      limit,
      order: "descending",
    });
  }

  /**
   * Reinitialize client with balance managers
   * Call this after creating a BalanceManager to register it with the SDK
   */
  reinitialize(balanceManagers: Record<string, BalanceManager>): void {
    const rpcUrl =
      config.sui.network === "mainnet"
        ? "https://fullnode.mainnet.sui.io:443"
        : "https://fullnode.testnet.sui.io:443";

    this.client = this.createExtendedClient(rpcUrl, balanceManagers);
    console.log(
      `Reinitialized with ${Object.keys(balanceManagers).length} balance manager(s)`,
    );
  }
}

// Singleton instance
export const suiService = new SuiService();
