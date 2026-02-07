/**
 * Position Analytics Service
 *
 * Tracks P&L, win rates, volume, and portfolio performance
 * for all mirror positions. Integrates with the mirror engine
 * to record every order execution.
 */

import {
  analyticsRepo,
  type DbPositionAnalytics,
} from "../db/analytics-repository.js";
import { positionRepo, orderRepo } from "../db/repository.js";
import type { PositionAnalytics, PortfolioSummary } from "../types/index.js";

export class AnalyticsService {
  /**
   * Record an order execution for analytics tracking
   */
  async recordOrderExecution(
    positionId: string,
    userTelegramId: string,
    price: number,
    quantity: number,
    isBid: boolean,
    success: boolean,
  ): Promise<void> {
    try {
      await analyticsRepo.recordOrder(
        positionId,
        userTelegramId,
        price,
        quantity,
        isBid,
        success,
      );
    } catch (error) {
      console.error(
        `[Analytics] Failed to record order for ${positionId}:`,
        error,
      );
    }
  }

  /**
   * Get analytics for a single position
   */
  async getPositionAnalytics(
    positionId: string,
  ): Promise<PositionAnalytics | null> {
    const analytics = await analyticsRepo.getByPosition(positionId);
    if (!analytics) return null;

    const position = await positionRepo.getById(positionId);
    const duration = position
      ? Date.now() - new Date(position.created_at).getTime()
      : 0;

    return this.formatAnalytics(analytics, duration);
  }

  /**
   * Get analytics for all positions of a user
   */
  async getUserPositionAnalytics(
    userTelegramId: string,
  ): Promise<PositionAnalytics[]> {
    const allAnalytics = await analyticsRepo.getAllByUser(userTelegramId);
    const positions = await positionRepo.getAllByUser(userTelegramId);

    const positionMap = new Map(positions.map((p) => [p.id, p]));

    return allAnalytics.map((a) => {
      const pos = positionMap.get(a.position_id);
      const duration = pos
        ? Date.now() - new Date(pos.created_at).getTime()
        : 0;
      return this.formatAnalytics(a, duration);
    });
  }

  /**
   * Get portfolio summary across all positions
   */
  async getPortfolioSummary(userTelegramId: string): Promise<PortfolioSummary> {
    const { totalPnl, totalVolume, totalWins, totalLosses, positions } =
      await analyticsRepo.getPortfolioSummary(userTelegramId);

    const activePositions = await positionRepo.getActiveByUser(userTelegramId);
    const allOrders = await orderRepo.getRecentByUser(userTelegramId, 1000);

    // Find top and worst performers
    let topPerformer: { poolKey: string; pnl: number } | null = null;
    let worstPerformer: { poolKey: string; pnl: number } | null = null;

    const positionData = await positionRepo.getAllByUser(userTelegramId);
    const posMap = new Map(positionData.map((p) => [p.id, p]));

    for (const a of positions) {
      const pos = posMap.get(a.position_id);
      if (!pos) continue;

      if (!topPerformer || a.total_pnl > topPerformer.pnl) {
        topPerformer = { poolKey: pos.pool_key, pnl: a.total_pnl };
      }
      if (!worstPerformer || a.total_pnl < worstPerformer.pnl) {
        worstPerformer = { poolKey: pos.pool_key, pnl: a.total_pnl };
      }
    }

    const totalPnlPercent =
      totalVolume > 0 ? (totalPnl / totalVolume) * 100 : 0;

    return {
      totalValue: totalVolume,
      totalPnl,
      totalPnlPercent,
      activePositions: activePositions.length,
      totalOrders: allOrders.length,
      topPerformer,
      worstPerformer,
    };
  }

  /**
   * Format a position's P&L display for Telegram
   */
  formatPnlDisplay(analytics: PositionAnalytics): string {
    const pnlEmoji = analytics.totalPnl >= 0 ? "📈" : "📉";
    const pnlSign = analytics.totalPnl >= 0 ? "+" : "";
    const winRate =
      analytics.winCount + analytics.lossCount > 0
        ? (
            (analytics.winCount / (analytics.winCount + analytics.lossCount)) *
            100
          ).toFixed(0)
        : "N/A";

    return (
      `${pnlEmoji} P&L: ${pnlSign}$${analytics.totalPnl.toFixed(2)} (${pnlSign}${analytics.totalPnlPercent.toFixed(1)}%)\n` +
      `📊 Volume: $${analytics.totalVolume.toFixed(2)}\n` +
      `🎯 Win Rate: ${winRate}% (${analytics.winCount}W/${analytics.lossCount}L)\n` +
      `⏱ Duration: ${this.formatDuration(analytics.duration)}`
    );
  }

  /**
   * Format portfolio summary for Telegram
   */
  formatPortfolioDisplay(summary: PortfolioSummary): string {
    const pnlEmoji = summary.totalPnl >= 0 ? "📈" : "📉";
    const pnlSign = summary.totalPnl >= 0 ? "+" : "";

    let msg =
      `💼 <b>Portfolio Overview</b>\n\n` +
      `Total Volume: $${summary.totalValue.toFixed(2)}\n` +
      `${pnlEmoji} P&L: ${pnlSign}$${summary.totalPnl.toFixed(2)} (${pnlSign}${summary.totalPnlPercent.toFixed(1)}%)\n` +
      `Active Positions: ${summary.activePositions}\n` +
      `Total Orders: ${summary.totalOrders}\n`;

    if (summary.topPerformer && summary.topPerformer.pnl !== 0) {
      msg += `\n🏆 Top: ${summary.topPerformer.poolKey} (+$${summary.topPerformer.pnl.toFixed(2)})`;
    }
    if (summary.worstPerformer && summary.worstPerformer.pnl < 0) {
      msg += `\n⚠️ Worst: ${summary.worstPerformer.poolKey} ($${summary.worstPerformer.pnl.toFixed(2)})`;
    }

    return msg;
  }

  /**
   * Format duration from milliseconds to human-readable
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  /**
   * Convert DB record to analytics interface
   */
  private formatAnalytics(
    a: DbPositionAnalytics,
    duration: number,
  ): PositionAnalytics {
    const totalOrders = a.win_count + a.loss_count;
    return {
      positionId: a.position_id,
      totalPnl: a.total_pnl,
      totalPnlPercent: a.total_pnl_percent,
      totalVolume: a.total_volume,
      winCount: a.win_count,
      lossCount: a.loss_count,
      winRate: totalOrders > 0 ? (a.win_count / totalOrders) * 100 : 0,
      avgOrderSize: a.avg_order_size,
      duration,
      lastUpdated: new Date(a.updated_at).getTime(),
    };
  }
}

// Singleton
export const analyticsService = new AnalyticsService();
