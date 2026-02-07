/**
 * Database Repository
 *
 * Data access layer for users, positions, and orders.
 * All methods use async Supabase calls for PostgreSQL.
 */

import { getDb } from "./schema.js";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface DbUser {
  id: number;
  telegram_id: string;
  telegram_username: string | null;
  sui_address: string | null;
  balance_manager_id: string | null;
  balance_manager_key: string | null;
  // zkLogin fields
  zklogin_address: string | null;
  zklogin_salt: string | null;
  zklogin_sub: string | null;
  zklogin_aud: string | null;
  ephemeral_keypair: string | null;
  ephemeral_public_key: string | null;
  max_epoch: number | null;
  jwt_randomness: string | null;
  zk_proof: string | null;
  zklogin_jwt: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbPosition {
  id: string;
  user_telegram_id: string;
  target_maker: string;
  pool_key: string;
  pool_id: string | null;
  ratio: number;
  is_active: boolean;
  balance_manager_key: string;
  total_orders_placed: number;
  total_volume: string;
  created_at: string;
  updated_at: string;
}

export interface DbOrder {
  id: number;
  position_id: string;
  maker_order_id: string | null;
  mirrored_order_id: string | null;
  pool_key: string;
  price: string;
  quantity: string;
  is_bid: boolean;
  tx_digest: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface DbCapability {
  id: string;
  position_id: string;
  user_telegram_id: string;
  operator_address: string;
  max_order_size: string;
  expires_at: number;
  is_active: boolean;
  created_at: string;
}

// ──────────────────────────────────────────────
//  User Repository
// ──────────────────────────────────────────────

export const userRepo = {
  /**
   * Find or create a user by Telegram ID
   */
  async findOrCreate(telegramId: string, username?: string): Promise<DbUser> {
    const db = getDb();

    // Try to find existing user
    const { data: existingUser } = await db
      .from("users")
      .select("*")
      .eq("telegram_id", telegramId)
      .single();

    if (existingUser) {
      return existingUser as DbUser;
    }

    // Create new user
    const { data: newUser, error } = await db
      .from("users")
      .insert({
        telegram_id: telegramId,
        telegram_username: username || null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }

    return newUser as DbUser;
  },

  /**
   * Get user by Telegram ID
   */
  async getByTelegramId(telegramId: string): Promise<DbUser | undefined> {
    const db = getDb();
    const { data, error } = await db
      .from("users")
      .select("*")
      .eq("telegram_id", telegramId)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 = no rows returned
      throw new Error(`Failed to get user: ${error.message}`);
    }

    return data ? (data as DbUser) : undefined;
  },

  /**
   * Link a Sui wallet address to a user
   */
  async linkWallet(telegramId: string, suiAddress: string): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("users")
      .update({
        sui_address: suiAddress,
        updated_at: new Date().toISOString(),
      })
      .eq("telegram_id", telegramId);

    if (error) {
      throw new Error(`Failed to link wallet: ${error.message}`);
    }
  },

  /**
   * Set balance manager for a user
   */
  async setBalanceManager(
    telegramId: string,
    balanceManagerId: string,
    balanceManagerKey: string,
  ): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("users")
      .update({
        balance_manager_id: balanceManagerId,
        balance_manager_key: balanceManagerKey,
        updated_at: new Date().toISOString(),
      })
      .eq("telegram_id", telegramId);

    if (error) {
      throw new Error(`Failed to set balance manager: ${error.message}`);
    }
  },

  /**
   * Save zkLogin session data (ephemeral key, nonce, etc.)
   */
  async saveZkLoginSession(
    telegramId: string,
    data: {
      ephemeralKeypair: string;
      ephemeralPublicKey: string;
      maxEpoch: number;
      jwtRandomness: string;
    },
  ): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("users")
      .update({
        ephemeral_keypair: data.ephemeralKeypair,
        ephemeral_public_key: data.ephemeralPublicKey,
        max_epoch: data.maxEpoch,
        jwt_randomness: data.jwtRandomness,
        updated_at: new Date().toISOString(),
      })
      .eq("telegram_id", telegramId);

    if (error) {
      throw new Error(`Failed to save zkLogin session: ${error.message}`);
    }
  },

  /**
   * Save zkLogin proof and address after OAuth callback
   */
  async saveZkLoginAuth(
    telegramId: string,
    data: {
      zkloginAddress: string;
      salt: string;
      sub: string;
      aud: string;
      zkProof: string;
      jwt: string;
    },
  ): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("users")
      .update({
        zklogin_address: data.zkloginAddress,
        zklogin_salt: data.salt,
        zklogin_sub: data.sub,
        zklogin_aud: data.aud,
        zk_proof: data.zkProof,
        zklogin_jwt: data.jwt,
        sui_address: data.zkloginAddress,
        updated_at: new Date().toISOString(),
      })
      .eq("telegram_id", telegramId);

    if (error) {
      throw new Error(`Failed to save zkLogin auth: ${error.message}`);
    }
  },

  /**
   * Clear zkLogin session data (on logout or expiry)
   */
  async clearZkLoginSession(telegramId: string): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("users")
      .update({
        ephemeral_keypair: null,
        ephemeral_public_key: null,
        max_epoch: null,
        jwt_randomness: null,
        zk_proof: null,
        zklogin_jwt: null,
        updated_at: new Date().toISOString(),
      })
      .eq("telegram_id", telegramId);

    if (error) {
      throw new Error(`Failed to clear zkLogin session: ${error.message}`);
    }
  },
};

// ──────────────────────────────────────────────
//  Position Repository
// ──────────────────────────────────────────────

export const positionRepo = {
  /**
   * Create a new position
   */
  async create(position: {
    id: string;
    userTelegramId: string;
    targetMaker: string;
    poolKey: string;
    poolId?: string;
    ratio: number;
    balanceManagerKey: string;
  }): Promise<DbPosition> {
    const db = getDb();

    const { data, error } = await db
      .from("positions")
      .insert({
        id: position.id,
        user_telegram_id: position.userTelegramId,
        target_maker: position.targetMaker,
        pool_key: position.poolKey,
        pool_id: position.poolId || null,
        ratio: position.ratio,
        balance_manager_key: position.balanceManagerKey,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create position: ${error.message}`);
    }

    return data as DbPosition;
  },

  /**
   * Get position by ID
   */
  async getById(id: string): Promise<DbPosition | undefined> {
    const db = getDb();
    const { data, error } = await db
      .from("positions")
      .select("*")
      .eq("id", id)
      .single();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to get position: ${error.message}`);
    }

    return data ? (data as DbPosition) : undefined;
  },

  /**
   * Get all active positions for a user
   */
  async getActiveByUser(telegramId: string): Promise<DbPosition[]> {
    const db = getDb();
    const { data, error } = await db
      .from("positions")
      .select("*")
      .eq("user_telegram_id", telegramId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to get active positions: ${error.message}`);
    }

    return (data as DbPosition[]) || [];
  },

  /**
   * Get all positions for a user (including inactive)
   */
  async getAllByUser(telegramId: string): Promise<DbPosition[]> {
    const db = getDb();
    const { data, error } = await db
      .from("positions")
      .select("*")
      .eq("user_telegram_id", telegramId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to get all positions: ${error.message}`);
    }

    return (data as DbPosition[]) || [];
  },

  /**
   * Get all active positions
   */
  async getAllActive(): Promise<DbPosition[]> {
    const db = getDb();
    const { data, error } = await db
      .from("positions")
      .select("*")
      .eq("is_active", true);

    if (error) {
      throw new Error(`Failed to get all active positions: ${error.message}`);
    }

    return (data as DbPosition[]) || [];
  },

  /**
   * Update position active status
   */
  async setActive(id: string, isActive: boolean): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("positions")
      .update({
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to set position active: ${error.message}`);
    }
  },

  /**
   * Update position ratio
   */
  async updateRatio(id: string, ratio: number): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("positions")
      .update({
        ratio,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to update ratio: ${error.message}`);
    }
  },

  /**
   * Increment order count
   */
  async incrementOrders(id: string): Promise<void> {
    const db = getDb();

    // Get current count
    const { data: position } = await db
      .from("positions")
      .select("total_orders_placed")
      .eq("id", id)
      .single();

    if (!position) {
      throw new Error("Position not found");
    }

    // Increment
    const { error } = await db
      .from("positions")
      .update({
        total_orders_placed: position.total_orders_placed + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to increment orders: ${error.message}`);
    }
  },

  /**
   * Delete a position
   */
  async delete(id: string): Promise<void> {
    const db = getDb();
    const { error } = await db.from("positions").delete().eq("id", id);

    if (error) {
      throw new Error(`Failed to delete position: ${error.message}`);
    }
  },
};

// ──────────────────────────────────────────────
//  Order Repository
// ──────────────────────────────────────────────

export const orderRepo = {
  /**
   * Record a new mirrored order
   */
  async create(order: {
    positionId: string;
    makerOrderId?: string;
    mirroredOrderId?: string;
    poolKey: string;
    price: string;
    quantity: string;
    isBid: boolean;
    txDigest?: string;
    status: string;
    error?: string;
  }): Promise<DbOrder> {
    const db = getDb();

    const { data, error } = await db
      .from("orders")
      .insert({
        position_id: order.positionId,
        maker_order_id: order.makerOrderId || null,
        mirrored_order_id: order.mirroredOrderId || null,
        pool_key: order.poolKey,
        price: order.price,
        quantity: order.quantity,
        is_bid: order.isBid,
        tx_digest: order.txDigest || null,
        status: order.status,
        error: order.error || null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create order: ${error.message}`);
    }

    return data as DbOrder;
  },

  /**
   * Get orders for a position
   */
  async getByPosition(positionId: string): Promise<DbOrder[]> {
    const db = getDb();
    const { data, error } = await db
      .from("orders")
      .select("*")
      .eq("position_id", positionId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to get orders by position: ${error.message}`);
    }

    return (data as DbOrder[]) || [];
  },

  /**
   * Get recent orders for a user
   */
  async getRecentByUser(
    telegramId: string,
    limit: number = 10,
  ): Promise<DbOrder[]> {
    const db = getDb();

    // First get position IDs for user
    const { data: positions } = await db
      .from("positions")
      .select("id")
      .eq("user_telegram_id", telegramId);

    if (!positions || positions.length === 0) {
      return [];
    }

    const positionIds = positions.map((p) => p.id);

    // Then get orders for those positions
    const { data, error } = await db
      .from("orders")
      .select("*")
      .in("position_id", positionIds)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to get recent orders: ${error.message}`);
    }

    return (data as DbOrder[]) || [];
  },

  /**
   * Update order status
   */
  async updateStatus(
    id: number,
    status: string,
    error?: string,
  ): Promise<void> {
    const db = getDb();
    const { error: updateError } = await db
      .from("orders")
      .update({
        status,
        error: error || null,
      })
      .eq("id", id);

    if (updateError) {
      throw new Error(`Failed to update order status: ${updateError.message}`);
    }
  },
};

// ──────────────────────────────────────────────
//  Capability Repository
// ──────────────────────────────────────────────

export const capabilityRepo = {
  /**
   * Save a new capability
   */
  async create(cap: {
    id: string;
    positionId: string;
    userTelegramId: string;
    operatorAddress: string;
    maxOrderSize: string;
    expiresAt: number;
  }): Promise<DbCapability> {
    const db = getDb();

    const { data, error } = await db
      .from("capabilities")
      .insert({
        id: cap.id,
        position_id: cap.positionId,
        user_telegram_id: cap.userTelegramId,
        operator_address: cap.operatorAddress,
        max_order_size: cap.maxOrderSize,
        expires_at: cap.expiresAt,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create capability: ${error.message}`);
    }

    return data as DbCapability;
  },

  /**
   * Get active capability for a position
   */
  async getByPosition(positionId: string): Promise<DbCapability | undefined> {
    const db = getDb();
    const { data, error } = await db
      .from("capabilities")
      .select("*")
      .eq("position_id", positionId)
      .eq("is_active", true)
      .single();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to get capability: ${error.message}`);
    }

    return data ? (data as DbCapability) : undefined;
  },

  /**
   * Get all active capabilities for a user
   */
  async getByUser(telegramId: string): Promise<DbCapability[]> {
    const db = getDb();
    const { data, error } = await db
      .from("capabilities")
      .select("*")
      .eq("user_telegram_id", telegramId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to get capabilities by user: ${error.message}`);
    }

    return (data as DbCapability[]) || [];
  },

  /**
   * Deactivate a capability
   */
  async deactivate(id: string): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from("capabilities")
      .update({ is_active: false })
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to deactivate capability: ${error.message}`);
    }
  },

  /**
   * Delete a capability
   */
  async delete(id: string): Promise<void> {
    const db = getDb();
    const { error } = await db.from("capabilities").delete().eq("id", id);

    if (error) {
      throw new Error(`Failed to delete capability: ${error.message}`);
    }
  },
};
