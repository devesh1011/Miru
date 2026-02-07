/**
 * Analytics & Risk Management Repository
 *
 * Data access layer for position analytics, risk settings,
 * and notification preferences.
 */

import { getDb } from "./schema.js";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface DbPositionAnalytics {
  id: number;
  position_id: string;
  user_telegram_id: string;
  total_pnl: number;
  total_pnl_percent: number;
  total_volume: number;
  win_count: number;
  loss_count: number;
  avg_entry_price: number;
  avg_order_size: number;
  last_price: number;
  created_at: string;
  updated_at: string;
}

export interface DbOrderPnl {
  id: number;
  order_id: number;
  position_id: string;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  pnl: number;
  pnl_percent: number;
  is_bid: boolean;
  status: string; // 'open' | 'filled' | 'canceled'
  created_at: string;
  updated_at: string;
}

export interface DbRiskSettings {
  id: number;
  user_telegram_id: string;
  position_id: string | null; // null = global defaults
  max_order_size: number;
  stop_loss_percent: number;
  take_profit_percent: number;
  daily_trade_limit: number;
  max_open_positions: number;
  auto_pause_on_loss: boolean;
  min_balance_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface DbNotificationPreferences {
  id: number;
  user_telegram_id: string;
  order_executed: boolean;
  position_created: boolean;
  position_stopped: boolean;
  pnl_updates: boolean;
  stop_loss_alerts: boolean;
  take_profit_alerts: boolean;
  balance_low_alerts: boolean;
  daily_summary: boolean;
  maker_performance_alerts: boolean;
  risk_limit_alerts: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbDailyTradeCount {
  id: number;
  user_telegram_id: string;
  position_id: string;
  trade_date: string;
  trade_count: number;
}

// ──────────────────────────────────────────────
//  Position Analytics Repository
// ──────────────────────────────────────────────

export const analyticsRepo = {
  /**
   * Get or create analytics record for a position
   */
  async getOrCreate(
    positionId: string,
    userTelegramId: string,
  ): Promise<DbPositionAnalytics> {
    const db = getDb();

    const { data: existing } = await db
      .from("position_analytics")
      .select("*")
      .eq("position_id", positionId)
      .single();

    if (existing) return existing as DbPositionAnalytics;

    const { data, error } = await db
      .from("position_analytics")
      .insert({
        position_id: positionId,
        user_telegram_id: userTelegramId,
        total_pnl: 0,
        total_pnl_percent: 0,
        total_volume: 0,
        win_count: 0,
        loss_count: 0,
        avg_entry_price: 0,
        avg_order_size: 0,
        last_price: 0,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create analytics: ${error.message}`);
    return data as DbPositionAnalytics;
  },

  /**
   * Get analytics for a position
   */
  async getByPosition(positionId: string): Promise<DbPositionAnalytics | null> {
    const db = getDb();
    const { data, error } = await db
      .from("position_analytics")
      .select("*")
      .eq("position_id", positionId)
      .single();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to get analytics: ${error.message}`);
    }
    return data ? (data as DbPositionAnalytics) : null;
  },

  /**
   * Get all analytics for a user
   */
  async getAllByUser(userTelegramId: string): Promise<DbPositionAnalytics[]> {
    const db = getDb();
    const { data, error } = await db
      .from("position_analytics")
      .select("*")
      .eq("user_telegram_id", userTelegramId)
      .order("updated_at", { ascending: false });

    if (error) throw new Error(`Failed to get analytics: ${error.message}`);
    return (data as DbPositionAnalytics[]) || [];
  },

  /**
   * Update analytics after an order is executed
   */
  async recordOrder(
    positionId: string,
    userTelegramId: string,
    price: number,
    quantity: number,
    isBid: boolean,
    success: boolean,
  ): Promise<void> {
    const db = getDb();
    const analytics = await this.getOrCreate(positionId, userTelegramId);

    const volume = price * quantity;
    const totalVolume = analytics.total_volume + volume;
    const orderCount = analytics.win_count + analytics.loss_count + 1;
    const avgOrderSize =
      (analytics.avg_order_size * (orderCount - 1) + quantity) / orderCount;

    // Simple P&L: compare entry vs last known price
    // Positive for bids when price goes up, asks when price goes down
    const priceDelta = price - (analytics.avg_entry_price || price);
    const orderPnl = isBid ? priceDelta * quantity : -priceDelta * quantity;

    const newPnl = analytics.total_pnl + (success ? orderPnl : 0);
    const newPnlPercent = totalVolume > 0 ? (newPnl / totalVolume) * 100 : 0;

    // Update average entry price (weighted)
    const prevTotal =
      analytics.avg_entry_price * (analytics.win_count + analytics.loss_count);
    const avgEntryPrice =
      orderCount > 0 ? (prevTotal + price) / orderCount : price;

    const isWin = orderPnl >= 0 && success;

    const { error } = await db
      .from("position_analytics")
      .update({
        total_pnl: newPnl,
        total_pnl_percent: newPnlPercent,
        total_volume: totalVolume,
        win_count: analytics.win_count + (isWin ? 1 : 0),
        loss_count: analytics.loss_count + (isWin ? 0 : 1),
        avg_entry_price: avgEntryPrice,
        avg_order_size: avgOrderSize,
        last_price: price,
        updated_at: new Date().toISOString(),
      })
      .eq("position_id", positionId);

    if (error) {
      throw new Error(`Failed to update analytics: ${error.message}`);
    }
  },

  /**
   * Get portfolio summary for a user
   */
  async getPortfolioSummary(userTelegramId: string): Promise<{
    totalPnl: number;
    totalVolume: number;
    totalWins: number;
    totalLosses: number;
    positions: DbPositionAnalytics[];
  }> {
    const positions = await this.getAllByUser(userTelegramId);

    let totalPnl = 0;
    let totalVolume = 0;
    let totalWins = 0;
    let totalLosses = 0;

    for (const p of positions) {
      totalPnl += p.total_pnl;
      totalVolume += p.total_volume;
      totalWins += p.win_count;
      totalLosses += p.loss_count;
    }

    return { totalPnl, totalVolume, totalWins, totalLosses, positions };
  },
};

// ──────────────────────────────────────────────
//  Risk Settings Repository
// ──────────────────────────────────────────────

export const riskSettingsRepo = {
  /**
   * Get global risk settings for a user (position_id IS NULL)
   */
  async getGlobal(userTelegramId: string): Promise<DbRiskSettings | null> {
    const db = getDb();
    const { data, error } = await db
      .from("risk_settings")
      .select("*")
      .eq("user_telegram_id", userTelegramId)
      .is("position_id", null)
      .single();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to get risk settings: ${error.message}`);
    }
    return data ? (data as DbRiskSettings) : null;
  },

  /**
   * Get risk settings for a specific position (falls back to global)
   */
  async getForPosition(
    userTelegramId: string,
    positionId: string,
  ): Promise<DbRiskSettings | null> {
    const db = getDb();

    // Try position-specific first
    const { data: posSpecific } = await db
      .from("risk_settings")
      .select("*")
      .eq("user_telegram_id", userTelegramId)
      .eq("position_id", positionId)
      .single();

    if (posSpecific) return posSpecific as DbRiskSettings;

    // Fall back to global
    return this.getGlobal(userTelegramId);
  },

  /**
   * Create or update risk settings
   */
  async upsert(settings: {
    userTelegramId: string;
    positionId?: string | null;
    maxOrderSize?: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
    dailyTradeLimit?: number;
    maxOpenPositions?: number;
    autoPauseOnLoss?: boolean;
    minBalanceThreshold?: number;
  }): Promise<DbRiskSettings> {
    const db = getDb();

    // Check if exists
    let query = db
      .from("risk_settings")
      .select("*")
      .eq("user_telegram_id", settings.userTelegramId);

    if (settings.positionId) {
      query = query.eq("position_id", settings.positionId);
    } else {
      query = query.is("position_id", null);
    }

    const { data: existing } = await query.single();

    const record = {
      user_telegram_id: settings.userTelegramId,
      position_id: settings.positionId || null,
      max_order_size: settings.maxOrderSize ?? 100,
      stop_loss_percent: settings.stopLossPercent ?? 15,
      take_profit_percent: settings.takeProfitPercent ?? 30,
      daily_trade_limit: settings.dailyTradeLimit ?? 50,
      max_open_positions: settings.maxOpenPositions ?? 10,
      auto_pause_on_loss: settings.autoPauseOnLoss ?? false,
      min_balance_threshold: settings.minBalanceThreshold ?? 0.5,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { data, error } = await db
        .from("risk_settings")
        .update(record)
        .eq("id", (existing as DbRiskSettings).id)
        .select()
        .single();

      if (error)
        throw new Error(`Failed to update risk settings: ${error.message}`);
      return data as DbRiskSettings;
    }

    const { data, error } = await db
      .from("risk_settings")
      .insert(record)
      .select()
      .single();

    if (error)
      throw new Error(`Failed to create risk settings: ${error.message}`);
    return data as DbRiskSettings;
  },
};

// ──────────────────────────────────────────────
//  Notification Preferences Repository
// ──────────────────────────────────────────────

export const notificationPrefsRepo = {
  /**
   * Get notification preferences (create defaults if not exist)
   */
  async getOrCreate(
    userTelegramId: string,
  ): Promise<DbNotificationPreferences> {
    const db = getDb();

    const { data: existing } = await db
      .from("notification_preferences")
      .select("*")
      .eq("user_telegram_id", userTelegramId)
      .single();

    if (existing) return existing as DbNotificationPreferences;

    const { data, error } = await db
      .from("notification_preferences")
      .insert({
        user_telegram_id: userTelegramId,
        order_executed: true,
        position_created: true,
        position_stopped: true,
        pnl_updates: false,
        stop_loss_alerts: true,
        take_profit_alerts: true,
        balance_low_alerts: true,
        daily_summary: false,
        maker_performance_alerts: true,
        risk_limit_alerts: true,
      })
      .select()
      .single();

    if (error)
      throw new Error(`Failed to create notification prefs: ${error.message}`);
    return data as DbNotificationPreferences;
  },

  /**
   * Update a single preference toggle
   */
  async togglePref(
    userTelegramId: string,
    pref: keyof Omit<
      DbNotificationPreferences,
      "id" | "user_telegram_id" | "created_at" | "updated_at"
    >,
    value: boolean,
  ): Promise<void> {
    const db = getDb();

    // Ensure record exists
    await this.getOrCreate(userTelegramId);

    const { error } = await db
      .from("notification_preferences")
      .update({
        [pref]: value,
        updated_at: new Date().toISOString(),
      })
      .eq("user_telegram_id", userTelegramId);

    if (error)
      throw new Error(`Failed to update notification pref: ${error.message}`);
  },

  /**
   * Update multiple preferences at once
   */
  async updateMultiple(
    userTelegramId: string,
    prefs: Partial<
      Omit<
        DbNotificationPreferences,
        "id" | "user_telegram_id" | "created_at" | "updated_at"
      >
    >,
  ): Promise<void> {
    const db = getDb();

    await this.getOrCreate(userTelegramId);

    const { error } = await db
      .from("notification_preferences")
      .update({
        ...prefs,
        updated_at: new Date().toISOString(),
      })
      .eq("user_telegram_id", userTelegramId);

    if (error)
      throw new Error(`Failed to update notification prefs: ${error.message}`);
  },
};

// ──────────────────────────────────────────────
//  Daily Trade Counter (for risk limits)
// ──────────────────────────────────────────────

export const dailyTradeRepo = {
  /**
   * Get today's trade count for a position
   */
  async getTodayCount(
    userTelegramId: string,
    positionId: string,
  ): Promise<number> {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];

    const { data } = await db
      .from("daily_trade_counts")
      .select("trade_count")
      .eq("user_telegram_id", userTelegramId)
      .eq("position_id", positionId)
      .eq("trade_date", today)
      .single();

    return data?.trade_count ?? 0;
  },

  /**
   * Get total trade count today across all positions
   */
  async getTotalTodayCount(userTelegramId: string): Promise<number> {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];

    const { data } = await db
      .from("daily_trade_counts")
      .select("trade_count")
      .eq("user_telegram_id", userTelegramId)
      .eq("trade_date", today);

    if (!data) return 0;
    return data.reduce(
      (sum: number, row: any) => sum + (row.trade_count || 0),
      0,
    );
  },

  /**
   * Increment today's trade count
   */
  async increment(userTelegramId: string, positionId: string): Promise<number> {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];

    const { data: existing } = await db
      .from("daily_trade_counts")
      .select("*")
      .eq("user_telegram_id", userTelegramId)
      .eq("position_id", positionId)
      .eq("trade_date", today)
      .single();

    if (existing) {
      const newCount = (existing as DbDailyTradeCount).trade_count + 1;
      await db
        .from("daily_trade_counts")
        .update({ trade_count: newCount })
        .eq("id", (existing as DbDailyTradeCount).id);
      return newCount;
    }

    const { data, error } = await db
      .from("daily_trade_counts")
      .insert({
        user_telegram_id: userTelegramId,
        position_id: positionId,
        trade_date: today,
        trade_count: 1,
      })
      .select()
      .single();

    if (error)
      throw new Error(`Failed to increment trade count: ${error.message}`);
    return 1;
  },
};
