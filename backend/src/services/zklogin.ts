/**
 * zkLogin Service
 *
 * Handles the complete zkLogin flow for non-custodial wallet management:
 *   1. Generate ephemeral keypair + nonce
 *   2. Build OAuth URL (Google)
 *   3. Process JWT callback → derive salt + address
 *   4. Fetch ZK proof from Mysten prover
 *   5. Sign transactions with zkLogin signature
 *
 * Uses client-managed salt (HMAC-SHA256 from master seed + provider:sub)
 * so each user gets a deterministic Sui address from their Google identity.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  genAddressSeed,
  jwtToAddress,
  getZkLoginSignature,
} from "@mysten/sui/zklogin";
import { createHmac } from "crypto";
import { config } from "../config/index.js";
import { suiService } from "../sui/client.js";
import { userRepo } from "../db/index.js";
import {
  withTimeout,
  withRetry,
  extractErrorMessage,
} from "../utils/errors.js";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ZkLoginSession {
  ephemeralKeypair: Ed25519Keypair;
  maxEpoch: number;
  randomness: string;
  nonce: string;
}

export interface ZkLoginAuth {
  address: string;
  salt: string;
  sub: string;
  aud: string;
  zkProof: PartialZkLoginSignature;
  maxEpoch: number;
  ephemeralKeypair: Ed25519Keypair;
}

export interface PartialZkLoginSignature {
  proofPoints: {
    a: string[];
    b: string[][];
    c: string[];
  };
  issBase64Details: {
    value: string;
    indexMod4: number;
  };
  headerBase64: string;
}

// ──────────────────────────────────────────────
//  zkLogin Service
// ──────────────────────────────────────────────

export class ZkLoginService {
  private proverUrl: string;
  private googleClientId: string;
  private redirectUrl: string;
  private masterSeed: string;

  constructor() {
    this.proverUrl = config.zkLogin.proverUrl;
    this.googleClientId = config.zkLogin.googleClientId;
    this.redirectUrl = config.zkLogin.redirectUrl;
    this.masterSeed = config.zkLogin.masterSeed;
  }

  // ──── Step 1: Initialize Login Session ────

  /**
   * Create a new zkLogin session for a user.
   * Generates ephemeral keypair, randomness, and nonce.
   * Stores session data in DB for later retrieval.
   */
  async initSession(telegramId: string): Promise<{
    nonce: string;
    oauthUrl: string;
  }> {
    // Get current epoch from Sui (use JSON-RPC client since gRPC CoreClient doesn't have this)
    let currentEpoch: number;
    try {
      const systemState = await withTimeout(
        withRetry(
          () => suiService.getJsonRpcClient().getLatestSuiSystemState(),
          { maxRetries: 2, label: "getLatestSuiSystemState" },
        ),
        15000,
        "Fetch current epoch",
      );
      currentEpoch = Number(systemState.epoch);
    } catch (error) {
      throw new Error(
        `Failed to fetch current Sui epoch. The network may be congested. Please try again. (${extractErrorMessage(error)})`,
      );
    }

    const maxEpoch = currentEpoch + config.zkLogin.maxEpochOffset;

    // Generate ephemeral keypair
    const ephemeralKeypair = new Ed25519Keypair();
    const randomness = generateRandomness();
    const nonce = generateNonce(
      ephemeralKeypair.getPublicKey(),
      maxEpoch,
      randomness,
    );

    // Store session in DB (serialize keypair as base64 secret key)
    // getSecretKey() returns a Bech32 string (suiprivkey1...); decode it to get the raw 32-byte seed
    const { secretKey: rawSeed } = decodeSuiPrivateKey(
      ephemeralKeypair.getSecretKey(),
    );
    const serializedKeypair = Buffer.from(rawSeed).toString("base64");

    userRepo.saveZkLoginSession(telegramId, {
      ephemeralKeypair: serializedKeypair,
      ephemeralPublicKey: ephemeralKeypair.getPublicKey().toBase64(),
      maxEpoch,
      jwtRandomness: randomness,
    });

    // Build OAuth URL
    const oauthUrl = this.buildGoogleAuthUrl(nonce);

    console.log(
      `🔐 zkLogin session initialized for user ${telegramId}, epoch ${currentEpoch}, maxEpoch ${maxEpoch}`,
    );

    return { nonce, oauthUrl };
  }

  // ──── Step 2: Build OAuth URL ────

  /**
   * Build Google OAuth URL for zkLogin authentication
   */
  buildGoogleAuthUrl(nonce: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.googleClientId);
    url.searchParams.set("response_type", "id_token");
    url.searchParams.set("redirect_uri", this.redirectUrl);
    url.searchParams.set("scope", "openid");
    url.searchParams.set("nonce", nonce);
    return url.toString();
  }

  // ──── Step 3: Process JWT Callback ────

  /**
   * Process the JWT from the OAuth callback.
   * Derives salt, computes zkLogin address, fetches ZK proof.
   * Returns the user's Sui address.
   */
  async processJwtCallback(
    telegramId: string,
    jwt: string,
  ): Promise<{
    address: string;
    sub: string;
  }> {
    // Validate JWT format early
    const parts = jwt.split(".");
    if (parts.length !== 3) {
      throw new Error(
        "Invalid JWT format. Make sure you copied the complete token from the callback page. It should have 3 parts separated by dots.",
      );
    }

    // Decode JWT to get claims
    let decoded: {
      sub: string;
      aud: string | string[];
      iss: string;
      nonce: string;
    };
    try {
      decoded = this.decodeJwt(jwt);
    } catch (decodeError) {
      throw new Error(
        `Malformed JWT token — could not decode. Please use /connect to start a fresh authentication. (${extractErrorMessage(decodeError)})`,
      );
    }

    const { sub, aud } = decoded;

    if (!sub || !aud) {
      throw new Error(
        "JWT missing required claims (sub, aud). The token may be corrupted. Please try /connect again.",
      );
    }

    // Ensure aud is a string (can be array in some JWTs)
    const audStr = Array.isArray(aud) ? aud[0] : aud;

    // Derive salt deterministically
    const salt = this.deriveSalt("google", sub);

    // Compute zkLogin address (legacyAddress=false for new format)
    const address = jwtToAddress(jwt, salt, false);

    // Retrieve session data from DB
    const user = userRepo.getByTelegramId(telegramId);
    if (!user?.ephemeral_keypair || !user?.max_epoch || !user?.jwt_randomness) {
      throw new Error(
        "No active zkLogin session found. Please start with /connect first.",
      );
    }

    // Reconstruct ephemeral keypair
    const ephemeralKeypair = this.deserializeKeypair(user.ephemeral_keypair);

    // The prover expects the EXTENDED ephemeral public key (flag byte + key bytes),
    // NOT the raw base64 public key. getExtendedEphemeralPublicKey() produces
    // the BCS-serialized form that the on-chain verifier also derives from the
    // Ed25519 user signature, so the Groth16 proof binds to the correct key.
    const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(
      ephemeralKeypair.getPublicKey(),
    );

    // Fetch ZK proof from prover
    const zkProof = await this.fetchZkProof(
      jwt,
      extendedEphemeralPublicKey,
      user.max_epoch,
      user.jwt_randomness,
      salt,
    );

    // Save auth data in DB
    userRepo.saveZkLoginAuth(telegramId, {
      zkloginAddress: address,
      salt,
      sub,
      aud: audStr,
      zkProof: JSON.stringify(zkProof),
      jwt,
    });

    console.log(
      `✅ zkLogin auth complete for user ${telegramId}: ${address.slice(0, 10)}...`,
    );

    return { address, sub };
  }

  // ──── Step 4: Salt Derivation ────

  /**
   * Derive a deterministic salt from provider + user subject ID.
   * Uses HMAC-SHA256 with the master seed.
   * Same user always gets the same salt → same Sui address.
   */
  deriveSalt(provider: string, sub: string): string {
    const hmac = createHmac("sha256", this.masterSeed);
    hmac.update(`${provider}:${sub}`);
    const hash = hmac.digest("hex");
    // Take 128 bits (32 hex chars) as salt
    return BigInt("0x" + hash.substring(0, 32)).toString();
  }

  // ──── Step 5: Fetch ZK Proof ────

  /**
   * Fetch a zero-knowledge proof from the Mysten Labs prover.
   * The proof proves JWT validity without revealing the JWT itself.
   */
  async fetchZkProof(
    jwt: string,
    ephemeralPublicKeyBase64: string,
    maxEpoch: number,
    randomness: string,
    salt: string,
  ): Promise<PartialZkLoginSignature> {
    console.log(`🔄 Fetching ZK proof from ${this.proverUrl}...`);

    let response: Response;
    try {
      response = await withTimeout(
        withRetry(
          () =>
            fetch(this.proverUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jwt,
                extendedEphemeralPublicKey: ephemeralPublicKeyBase64,
                maxEpoch: maxEpoch.toString(),
                jwtRandomness: randomness,
                salt,
                keyClaimName: "sub",
              }),
            }),
          {
            maxRetries: 2,
            baseDelayMs: 2000,
            label: "ZK Prover request",
            retryOn: (err) => {
              const msg = extractErrorMessage(err);
              // Only retry on network/timeout errors, not on 4xx
              return /ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|timeout|503|502/i.test(
                msg,
              );
            },
          },
        ),
        30000,
        "ZK Prover",
      );
    } catch (fetchError) {
      throw new Error(
        `Could not reach the ZK prover service. It may be temporarily unavailable. Please try /connect again in a minute. (${extractErrorMessage(fetchError)})`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      if (response.status === 429) {
        throw new Error(
          "ZK Prover rate limited. Please wait a minute before trying /connect again.",
        );
      }
      if (response.status >= 500) {
        throw new Error(
          `ZK Prover service error (${response.status}). The service may be temporarily down. Try again shortly.`,
        );
      }
      // Parse known prover error messages
      if (errorText.includes("nonce")) {
        throw new Error(
          "Nonce mismatch — the session may have been overwritten. Use /connect to start a fresh session.",
        );
      }
      if (errorText.includes("audience")) {
        throw new Error(
          "OAuth client ID not supported by the prover. This is a configuration issue.",
        );
      }
      throw new Error(`ZK Prover error (${response.status}): ${errorText}`);
    }

    const proof = (await response.json()) as PartialZkLoginSignature;
    console.log(`✅ ZK proof received`);
    return proof;
  }

  // ──── Step 6: Sign & Execute Transaction ────

  /**
   * Sign a transaction using zkLogin and execute it.
   * This is the core function for non-custodial transaction execution.
   *
   * @param telegramId - User's Telegram ID (to retrieve session data)
   * @param buildTx - Function that populates the transaction
   * @returns Transaction digest
   */
  async signAndExecute(
    telegramId: string,
    buildTx: (tx: Transaction) => void,
  ): Promise<string> {
    const user = userRepo.getByTelegramId(telegramId);
    if (
      !user?.zklogin_address ||
      !user?.ephemeral_keypair ||
      !user?.max_epoch ||
      !user?.zk_proof ||
      !user?.zklogin_salt ||
      !user?.zklogin_sub ||
      !user?.zklogin_aud
    ) {
      throw new Error(
        "zkLogin session not complete. Please authenticate with /connect first.",
      );
    }

    // Reconstruct ephemeral keypair
    const ephemeralKeypair = this.deserializeKeypair(user.ephemeral_keypair);
    const zkProof = JSON.parse(user.zk_proof) as PartialZkLoginSignature;

    // Build the transaction
    const tx = new Transaction();
    tx.setSender(user.zklogin_address);
    buildTx(tx);

    // Sign with ephemeral key
    const client = suiService.getClient().core;
    const { bytes, signature: userSignature } = await tx.sign({
      client,
      signer: ephemeralKeypair,
    });

    // Compute address seed
    const addressSeed = genAddressSeed(
      BigInt(user.zklogin_salt),
      "sub",
      user.zklogin_sub,
      user.zklogin_aud,
    ).toString();

    // Assemble zkLogin signature
    const zkLoginSignature = getZkLoginSignature({
      inputs: {
        ...zkProof,
        addressSeed,
      },
      maxEpoch: user.max_epoch,
      userSignature,
    });

    // Execute the transaction
    const result = await suiService.getJsonRpcClient().executeTransactionBlock({
      transactionBlock: bytes,
      signature: zkLoginSignature,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    const digest = result.digest;
    console.log(`✅ zkLogin transaction executed: ${digest}`);

    return digest;
  }

  /**
   * Sign and execute a transaction, returning the full result including
   * objectChanges so callers can extract created object IDs.
   */
  async signAndExecuteFull(
    telegramId: string,
    buildTx: (tx: Transaction) => void,
  ): Promise<{
    digest: string;
    objectChanges?: any[];
    effects?: any;
  }> {
    const user = userRepo.getByTelegramId(telegramId);
    if (
      !user?.zklogin_address ||
      !user?.ephemeral_keypair ||
      !user?.max_epoch ||
      !user?.zk_proof ||
      !user?.zklogin_salt ||
      !user?.zklogin_sub ||
      !user?.zklogin_aud
    ) {
      throw new Error(
        "zkLogin session not complete. Please authenticate with /connect first.",
      );
    }

    const ephemeralKeypair = this.deserializeKeypair(user.ephemeral_keypair);
    const zkProof = JSON.parse(user.zk_proof) as PartialZkLoginSignature;

    const tx = new Transaction();
    tx.setSender(user.zklogin_address);
    buildTx(tx);

    const client = suiService.getClient().core;
    const { bytes, signature: userSignature } = await tx.sign({
      client,
      signer: ephemeralKeypair,
    });

    const addressSeed = genAddressSeed(
      BigInt(user.zklogin_salt),
      "sub",
      user.zklogin_sub,
      user.zklogin_aud,
    ).toString();

    const zkLoginSignature = getZkLoginSignature({
      inputs: {
        ...zkProof,
        addressSeed,
      },
      maxEpoch: user.max_epoch,
      userSignature,
    });

    const result = await suiService.getJsonRpcClient().executeTransactionBlock({
      transactionBlock: bytes,
      signature: zkLoginSignature,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      },
    });

    console.log(`✅ zkLogin transaction executed (full): ${result.digest}`);

    return {
      digest: result.digest,
      objectChanges: (result as any).objectChanges,
      effects: (result as any).effects,
    };
  }

  // ──── Step 7: Check Session Validity ────

  /**
   * Check if a user's zkLogin session is still valid (not expired).
   */
  async isSessionValid(telegramId: string): Promise<boolean> {
    const user = userRepo.getByTelegramId(telegramId);
    if (!user?.max_epoch || !user?.zklogin_address || !user?.zk_proof) {
      return false;
    }

    try {
      const systemState = await suiService
        .getJsonRpcClient()
        .getLatestSuiSystemState();
      const currentEpoch = Number(systemState.epoch);
      return currentEpoch <= user.max_epoch;
    } catch {
      return false;
    }
  }

  /**
   * Get the user's zkLogin address (or null if not authenticated)
   */
  getUserAddress(telegramId: string): string | null {
    const user = userRepo.getByTelegramId(telegramId);
    return user?.zklogin_address || null;
  }

  // ──── Utility Functions ────

  /**
   * Decode a JWT without verification (we trust the prover to verify)
   */
  private decodeJwt(jwt: string): {
    sub: string;
    aud: string | string[];
    iss: string;
    nonce: string;
  } {
    const parts = jwt.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format");
    }
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );
    return payload;
  }

  /**
   * Serialize an Ed25519Keypair to base64 string
   */
  serializeKeypair(keypair: Ed25519Keypair): string {
    // getSecretKey() returns a Bech32 string; decode to get the raw 32-byte seed
    const { secretKey: rawSeed } = decodeSuiPrivateKey(keypair.getSecretKey());
    return Buffer.from(rawSeed).toString("base64");
  }

  /**
   * Deserialize an Ed25519Keypair from base64 string
   */
  private deserializeKeypair(serialized: string): Ed25519Keypair {
    const secretKey = Buffer.from(serialized, "base64");
    return Ed25519Keypair.fromSecretKey(new Uint8Array(secretKey));
  }
}

// Singleton
export const zkLoginService = new ZkLoginService();
