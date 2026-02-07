/**
 * Risk Management Service
 *
 * Enforces position-level and portfolio-level risk limits:
 * - Max order size
 * - Stop loss auto-pause
 * - Take profit notifications
 * - Daily trade limits
 * - Max open positions
 * - Min balance threshold
 */

import {
  riskSettingsRepo,
  analyticsRepo,
  dailyTradeRepo,
} from "../db/analytics-repository.js";
import { positionRepo, userRepo } from "../db/repository.js";
import { suiService } from "../sui/client.js";
import { smartNotifier } from "./smart-notifier.js";
import { mirrorEngine } from "./mirror-engine.js";
import type { MakerOrderEvent } from "./mirror-engine.js";
import type { RiskSettings, DEFAULT_RISK_SETTINGS } from "../types/index.js";

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  riskType?: string;
}

export class RiskManagementService {
  /**
   * Pre-trade risk check — called before executing a mirror order
   * Returns whether the trade should proceed
   */
  async checkPreTrade(
    userTelegramId: string,
    positionId: string,
    poolKey: string,
    quantity: number,
    price: number,
  ): Promise<RiskCheckResult> {
    try {
      const settings = await riskSettingsRepo.getForPosition(
        userTelegramId,
        positionId,
      );

      if (!settings) {
        // No risk settings configured, allow trade
        return { allowed: true };
      }

      // 1. Max Order Size Check
      const orderValue = quantity * price;
      if (orderValue > settings.max_order_size) {
        await smartNotifier.notifyRiskLimitReached(
          userTelegramId,
          "Max Order Size",
          `Order value: $${orderValue.toFixed(2)}\nLimit: $${settings.max_order_size}`,
        );
        return {
          allowed: false,
          reason: `Order value ($${orderValue.toFixed(2)}) exceeds max order size ($${settings.max_order_size})`,
          riskType: "max_order_size",
        };
      }

      // 2. Daily Trade Limit Check
      const todayCount = await dailyTradeRepo.getTodayCount(
        userTelegramId,
        positionId,
      );
      if (todayCount >= settings.daily_trade_limit) {
        await smartNotifier.notifyRiskLimitReached(
          userTelegramId,
          "Daily Trade Limit",
          `Trades today: ${todayCount}\nLimit: ${settings.daily_trade_limit}`,
        );
        return {
          allowed: false,
          reason: `Daily trade limit reached (${todayCount}/${settings.daily_trade_limit})`,
          riskType: "daily_limit",
        };
      }

      // 3. Max Open Positions Check (only for new positions)
      const activePositions =
        await positionRepo.getActiveByUser(userTelegramId);
      if (activePositions.length > settings.max_open_positions) {
        await smartNotifier.notifyRiskLimitReached(
          userTelegramId,
          "Max Open Positions",
          `Active: ${activePositions.length}\nLimit: ${settings.max_open_positions}`,
        );
        return {
          allowed: false,
          reason: `Max open positions reached (${activePositions.length}/${settings.max_open_positions})`,
          riskType: "max_positions",
        };
      }

      // 4. Min Balance Threshold Check
      const user = await userRepo.getByTelegramId(userTelegramId);
      if (user?.zklogin_address) {
        try {
          const rawBalance = await suiService.getBalance(user.zklogin_address);
          const balance = parseInt(rawBalance) / 1_000_000_000;

          if (balance < settings.min_balance_threshold) {
            await smartNotifier.notifyLowBalance(
              userTelegramId,
              balance,
              settings.min_balance_threshold,
            );
            return {
              allowed: false,
              reason: `Balance too low (${balance.toFixed(4)} SUI < ${settings.min_balance_threshold} SUI threshold)`,
              riskType: "min_balance",
            };
          }
        } catch {
          // Can't check balance, allow trade
        }
      }

      return { allowed: true };
    } catch (error) {
      console.error("[RiskMgmt] Pre-trade check failed:", error);
      // On error, allow trade (fail-open)
      return { allowed: true };
    }
  }

  /**
   * Post-trade risk check — called after order execution
   * Checks stop loss and take profit conditions
   */
  async checkPostTrade(
    userTelegramId: string,
    positionId: string,
    poolKey: string,
  ): Promise<void> {
    try {
      const settings = await riskSettingsRepo.getForPosition(
        userTelegramId,
        positionId,
      );
      if (!settings) return;

      const analytics = await analyticsRepo.getByPosition(positionId);
      if (!analytics) return;

      // Increment daily trade count
      await dailyTradeRepo.increment(userTelegramId, positionId);

      // Check Stop Loss
      if (
        settings.stop_loss_percent > 0 &&
        analytics.total_pnl_percent <= -settings.stop_loss_percent
      ) {
        console.log(
          `[RiskMgmt] Stop loss triggered for ${positionId}: ${analytics.total_pnl_percent.toFixed(1)}%`,
        );

        // Auto-pause position
        await positionRepo.setActive(positionId, false);
        mirrorEngine.unregisterPosition(positionId);

        await smartNotifier.notifyStopLossTriggered(
          userTelegramId,
          positionId,
          poolKey,
          analytics.total_pnl_percent,
          settings.stop_loss_percent,
        );
      }

      // Check Take Profit
      if (
        settings.take_profit_percent > 0 &&
        analytics.total_pnl_percent >= settings.take_profit_percent
      ) {
        await smartNotifier.notifyTakeProfitHit(
          userTelegramId,
          positionId,
          poolKey,
          analytics.total_pnl_percent,
          settings.take_profit_percent,
        );
      }

      // Check Auto-Pause on Loss
      if (settings.auto_pause_on_loss && analytics.total_pnl < 0) {
        const totalOrders = analytics.win_count + analytics.loss_count;
        if (totalOrders >= 5 && analytics.win_count / totalOrders < 0.3) {
          // Win rate below 30% after at least 5 orders
          console.log(
            `[RiskMgmt] Auto-pausing ${positionId} due to poor performance`,
          );

          await positionRepo.setActive(positionId, false);
          mirrorEngine.unregisterPosition(positionId);

          await smartNotifier.notifyMakerPerformanceAlert(
            userTelegramId,
            (await positionRepo.getById(positionId))?.target_maker || "",
            poolKey,
            (analytics.win_count / totalOrders) * 100,
            analytics.loss_count,
          );
        }
      }
    } catch (error) {
      console.error("[RiskMgmt] Post-trade check failed:", error);
    }
  }

  /**
   * Get current risk settings for display in bot
   */
  async getUserRiskSettings(userTelegramId: string): Promise<{
    maxOrderSize: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    dailyTradeLimit: number;
    maxOpenPositions: number;
    autoPauseOnLoss: boolean;
    minBalanceThreshold: number;
    todayTradeCount: number;
  }> {
    const settings = await riskSettingsRepo.getGlobal(userTelegramId);
    const todayCount = await dailyTradeRepo.getTotalTodayCount(userTelegramId);

    if (!settings) {
      return {
        maxOrderSize: 100,
        stopLossPercent: 15,
        takeProfitPercent: 30,
        dailyTradeLimit: 50,
        maxOpenPositions: 10,
        autoPauseOnLoss: false,
        minBalanceThreshold: 0.5,
        todayTradeCount: todayCount,
      };
    }

    return {
      maxOrderSize: settings.max_order_size,
      stopLossPercent: settings.stop_loss_percent,
      takeProfitPercent: settings.take_profit_percent,
      dailyTradeLimit: settings.daily_trade_limit,
      maxOpenPositions: settings.max_open_positions,
      autoPauseOnLoss: settings.auto_pause_on_loss,
      minBalanceThreshold: settings.min_balance_threshold,
      todayTradeCount: todayCount,
    };
  }

  /**
   * Format risk settings for Telegram display
   */
  formatRiskDisplay(
    settings: Awaited<ReturnType<typeof this.getUserRiskSettings>>,
  ): string {
    return (
      `🛡️ <b>Risk Management</b>\n\n` +
      `Max Order Size: $${settings.maxOrderSize}\n` +
      `Stop Loss: ${settings.stopLossPercent > 0 ? `-${settings.stopLossPercent}%` : "Off"}\n` +
      `Take Profit: ${settings.takeProfitPercent > 0 ? `+${settings.takeProfitPercent}%` : "Off"}\n` +
      `Daily Trade Limit: ${settings.todayTradeCount}/${settings.dailyTradeLimit}\n` +
      `Max Open Positions: ${settings.maxOpenPositions}\n` +
      `Auto-pause on Loss: ${settings.autoPauseOnLoss ? "✅ On" : "❌ Off"}\n` +
      `Min Balance: ${settings.minBalanceThreshold} SUI`
    );
  }
}

// Singleton
export const riskManager = new RiskManagementService();
