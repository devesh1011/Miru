/**
 * Smart Notification Service
 *
 * Enhanced notification system that respects user preferences,
 * sends P&L alerts, performance degradation warnings, balance
 * warnings, and scheduled daily summaries.
 */

import { getBot } from "../bot/index.js";
import {
  notificationPrefsRepo,
  analyticsRepo,
  type DbNotificationPreferences,
} from "../db/analytics-repository.js";
import { positionRepo, userRepo } from "../db/repository.js";
import { analyticsService } from "./analytics.js";
import { suiService } from "../sui/client.js";
import type { MirrorExecutionResult } from "./mirror-engine.js";

/**
 * Send a notification to a user via Telegram (HTML parse mode)
 */
async function sendToUser(telegramId: string, message: string): Promise<void> {
  const bot = getBot();
  if (!bot) {
    console.log(
      `[SmartNotifier] Bot not available, skipping notification to ${telegramId}`,
    );
    return;
  }

  try {
    await bot.telegram.sendMessage(telegramId, message, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error(`[SmartNotifier] Failed to send to ${telegramId}:`, error);
  }
}

function truncate(s: string): string {
  if (!s || s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

export class SmartNotificationService {
  private dailySummaryInterval: ReturnType<typeof setInterval> | null = null;
  private balanceCheckInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Start periodic notification jobs
   */
  start(): void {
    // Check balances every 15 minutes
    this.balanceCheckInterval = setInterval(
      () => this.checkAllBalances(),
      15 * 60 * 1000,
    );

    // Daily summary at midnight UTC
    this.scheduleDailySummary();

    console.log("[SmartNotifier] Started periodic notification jobs");
  }

  /**
   * Stop periodic jobs
   */
  stop(): void {
    if (this.dailySummaryInterval) {
      clearInterval(this.dailySummaryInterval);
      this.dailySummaryInterval = null;
    }
    if (this.balanceCheckInterval) {
      clearInterval(this.balanceCheckInterval);
      this.balanceCheckInterval = null;
    }
    console.log("[SmartNotifier] Stopped periodic notification jobs");
  }

  /**
   * Notify about a mirrored order (enhanced with P&L)
   */
  async notifyOrderExecuted(result: MirrorExecutionResult): Promise<void> {
    const position = await positionRepo.getById(result.positionId);
    if (!position) return;

    const prefs = await notificationPrefsRepo.getOrCreate(
      position.user_telegram_id,
    );

    // Always record analytics regardless of notification preference
    await analyticsService.recordOrderExecution(
      result.positionId,
      position.user_telegram_id,
      result.price,
      result.quantity,
      result.isBid,
      result.success,
    );

    if (!prefs.order_executed) return;

    const side = result.isBid ? "📗 BID" : "📕 ASK";
    const status = result.success ? "✅" : "❌";

    // Get current analytics for P&L context
    const analytics = await analyticsService.getPositionAnalytics(
      result.positionId,
    );

    let pnlLine = "";
    if (analytics) {
      const pnlSign = analytics.totalPnl >= 0 ? "+" : "";
      const pnlEmoji = analytics.totalPnl >= 0 ? "📈" : "📉";
      pnlLine = `\n${pnlEmoji} Position P&L: ${pnlSign}$${analytics.totalPnl.toFixed(2)} (${pnlSign}${analytics.totalPnlPercent.toFixed(1)}%)`;
      pnlLine += `\n🎯 Win Rate: ${analytics.winRate.toFixed(0)}%`;
    }

    const message = result.success
      ? `🎯 <b>Order Executed!</b>\n\n` +
        `${side} ${result.quantity.toFixed(4)} @ $${result.price.toFixed(4)}\n` +
        `Pool: ${position.pool_key}\n` +
        `Maker: <code>${truncate(position.target_maker)}</code>\n` +
        `Ratio: ${position.ratio}%\n` +
        `Tx: <code>${truncate(result.txDigest)}</code>` +
        pnlLine
      : `${status} <b>Mirror Failed</b>\n\n` +
        `${side} ${result.quantity.toFixed(4)} @ $${result.price.toFixed(4)}\n` +
        `Pool: ${position.pool_key}\n` +
        `Error: ${result.error}`;

    await sendToUser(position.user_telegram_id, message);
  }

  /**
   * Notify when stop loss is triggered
   */
  async notifyStopLossTriggered(
    telegramId: string,
    positionId: string,
    poolKey: string,
    pnlPercent: number,
    stopLossPercent: number,
  ): Promise<void> {
    const prefs = await notificationPrefsRepo.getOrCreate(telegramId);
    if (!prefs.stop_loss_alerts) return;

    const message =
      `🛑 <b>Stop Loss Triggered!</b>\n\n` +
      `Position: ${poolKey}\n` +
      `P&L: ${pnlPercent.toFixed(1)}%\n` +
      `Stop Loss: -${stopLossPercent}%\n\n` +
      `⏸ Position has been auto-paused.\n` +
      `Review and reactivate when ready.`;

    await sendToUser(telegramId, message);
  }

  /**
   * Notify when take profit target is reached
   */
  async notifyTakeProfitHit(
    telegramId: string,
    positionId: string,
    poolKey: string,
    pnlPercent: number,
    takeProfitPercent: number,
  ): Promise<void> {
    const prefs = await notificationPrefsRepo.getOrCreate(telegramId);
    if (!prefs.take_profit_alerts) return;

    const message =
      `🎉 <b>Take Profit Reached!</b>\n\n` +
      `Position: ${poolKey}\n` +
      `P&L: +${pnlPercent.toFixed(1)}%\n` +
      `Target: +${takeProfitPercent}%\n\n` +
      `💡 Consider securing profits or adjusting your target.`;

    await sendToUser(telegramId, message);
  }

  /**
   * Notify about low balance
   */
  async notifyLowBalance(
    telegramId: string,
    balance: number,
    threshold: number,
  ): Promise<void> {
    const prefs = await notificationPrefsRepo.getOrCreate(telegramId);
    if (!prefs.balance_low_alerts) return;

    const message =
      `⚠️ <b>Low Balance Warning!</b>\n\n` +
      `Current SUI: ${balance.toFixed(4)}\n` +
      `Threshold: ${threshold} SUI\n\n` +
      `Copy trading may fail without sufficient gas.\n` +
      `💡 Deposit SUI to continue mirroring.`;

    await sendToUser(telegramId, message);
  }

  /**
   * Notify about maker performance degradation
   */
  async notifyMakerPerformanceAlert(
    telegramId: string,
    makerAddress: string,
    poolKey: string,
    winRate: number,
    recentLosses: number,
  ): Promise<void> {
    const prefs = await notificationPrefsRepo.getOrCreate(telegramId);
    if (!prefs.maker_performance_alerts) return;

    const message =
      `⚠️ <b>Maker Performance Alert</b>\n\n` +
      `Maker: <code>${truncate(makerAddress)}</code>\n` +
      `Pool: ${poolKey}\n` +
      `Win Rate: ${winRate.toFixed(0)}%\n` +
      `Recent Losses: ${recentLosses}\n\n` +
      `💡 Consider reviewing or pausing this position.`;

    await sendToUser(telegramId, message);
  }

  /**
   * Notify when a risk limit is reached
   */
  async notifyRiskLimitReached(
    telegramId: string,
    limitType: string,
    details: string,
  ): Promise<void> {
    const prefs = await notificationPrefsRepo.getOrCreate(telegramId);
    if (!prefs.risk_limit_alerts) return;

    const message =
      `🛡️ <b>Risk Limit Reached</b>\n\n` +
      `Limit: ${limitType}\n` +
      `${details}\n\n` +
      `Order was blocked by your risk settings.`;

    await sendToUser(telegramId, message);
  }

  /**
   * Send daily summary to all subscribed users
   */
  async sendDailySummaries(): Promise<void> {
    console.log("[SmartNotifier] Sending daily summaries...");

    try {
      // Get all users by querying active positions
      const activePositions = await positionRepo.getAllActive();
      const userIds = [
        ...new Set(activePositions.map((p) => p.user_telegram_id)),
      ];

      for (const telegramId of userIds) {
        try {
          const prefs = await notificationPrefsRepo.getOrCreate(telegramId);
          if (!prefs.daily_summary) continue;

          const summary =
            await analyticsService.getPortfolioSummary(telegramId);

          if (summary.totalOrders === 0 && summary.activePositions === 0) {
            continue;
          }

          const message =
            `📊 <b>Daily Summary</b>\n\n` +
            analyticsService.formatPortfolioDisplay(summary) +
            `\n\n📅 ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`;

          await sendToUser(telegramId, message);
        } catch (error) {
          console.error(
            `[SmartNotifier] Failed summary for ${telegramId}:`,
            error,
          );
        }
      }

      console.log(
        `[SmartNotifier] Sent daily summaries to ${userIds.length} users`,
      );
    } catch (error) {
      console.error("[SmartNotifier] Daily summary job failed:", error);
    }
  }

  /**
   * Check balances for all active users
   */
  private async checkAllBalances(): Promise<void> {
    try {
      const activePositions = await positionRepo.getAllActive();
      const userIds = [
        ...new Set(activePositions.map((p) => p.user_telegram_id)),
      ];

      for (const telegramId of userIds) {
        try {
          const user = await userRepo.getByTelegramId(telegramId);
          if (!user?.zklogin_address) continue;

          const rawBalance = await suiService.getBalance(user.zklogin_address);
          const balance = parseInt(rawBalance) / 1_000_000_000;

          // Default threshold
          const threshold = 0.5;

          if (balance < threshold) {
            await this.notifyLowBalance(telegramId, balance, threshold);
          }
        } catch {
          // Skip individual user errors
        }
      }
    } catch (error) {
      console.error("[SmartNotifier] Balance check failed:", error);
    }
  }

  /**
   * Schedule daily summary at midnight UTC
   */
  private scheduleDailySummary(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
      this.sendDailySummaries();
      // Then repeat every 24 hours
      this.dailySummaryInterval = setInterval(
        () => this.sendDailySummaries(),
        24 * 60 * 60 * 1000,
      );
    }, msUntilMidnight);
  }
}

// Singleton
export const smartNotifier = new SmartNotificationService();
