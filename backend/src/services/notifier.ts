/**
 * Notification Service
 *
 * Sends Telegram alerts to users when mirror events occur.
 * (Order placed, order filled, errors, etc.)
 */

import { getBot } from "../bot/index.js";
import { positionRepo, orderRepo, userRepo } from "../db/index.js";
import type { MirrorExecutionResult } from "../services/mirror-engine.js";

/**
 * Send a notification to a user via Telegram
 */
async function sendToUser(telegramId: string, message: string): Promise<void> {
  const bot = getBot();
  if (!bot) {
    console.log(
      `[Notifier] Bot not available, skipping notification to ${telegramId}`,
    );
    return;
  }

  try {
    await bot.telegram.sendMessage(telegramId, message, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error(`[Notifier] Failed to send message to ${telegramId}:`, error);
  }
}

/**
 * Notify user about a successful mirror order
 */
export async function notifyOrderMirrored(
  result: MirrorExecutionResult,
): Promise<void> {
  // Find the position in DB to get the user
  const position = positionRepo.getById(result.positionId);
  if (!position) return;

  const side = result.isBid ? "📗 BID" : "📕 ASK";
  const status = result.success ? "✅" : "❌";

  // Record in DB
  orderRepo.create({
    positionId: result.positionId,
    makerOrderId: result.makerOrderId,
    mirroredOrderId: result.mirroredOrderId,
    poolKey: position.pool_key,
    price: result.price.toString(),
    quantity: result.quantity.toString(),
    isBid: result.isBid,
    txDigest: result.txDigest,
    status: result.success ? "confirmed" : "failed",
    error: result.error,
  });

  if (result.success) {
    positionRepo.incrementOrders(result.positionId);
  }

  const message = result.success
    ? `${status} <b>Order Mirrored</b>\n\n` +
      `${side} ${result.quantity} @ ${result.price}\n` +
      `Pool: ${position.pool_key}\n` +
      `Maker: ${truncate(position.target_maker)}\n` +
      `Ratio: ${position.ratio}%\n` +
      `Tx: <code>${truncate(result.txDigest)}</code>`
    : `${status} <b>Mirror Failed</b>\n\n` +
      `${side} ${result.quantity} @ ${result.price}\n` +
      `Pool: ${position.pool_key}\n` +
      `Error: ${result.error}`;

  await sendToUser(position.user_telegram_id, message);
}

/**
 * Notify user that a position was created
 */
export async function notifyPositionCreated(
  telegramId: string,
  positionId: string,
  poolKey: string,
  makerAddress: string,
  ratio: number,
): Promise<void> {
  const message =
    `🪞 <b>Mirror Position Created</b>\n\n` +
    `Pool: ${poolKey}\n` +
    `Maker: <code>${truncate(makerAddress)}</code>\n` +
    `Ratio: ${ratio}%\n` +
    `ID: <code>${truncate(positionId)}</code>\n\n` +
    `The bot will now automatically mirror this maker's limit orders.`;

  await sendToUser(telegramId, message);
}

/**
 * Notify user that a position was stopped
 */
export async function notifyPositionStopped(
  telegramId: string,
  positionId: string,
): Promise<void> {
  const message =
    `⏸ <b>Position Stopped</b>\n\n` +
    `ID: <code>${truncate(positionId)}</code>\n\n` +
    `Mirroring has been paused for this position.`;

  await sendToUser(telegramId, message);
}

/**
 * Notify about system events (e.g., engine restart, errors)
 */
export async function notifySystemEvent(
  telegramId: string,
  event: string,
  details?: string,
): Promise<void> {
  const message =
    `ℹ️ <b>System Event</b>\n\n` + `${event}` + (details ? `\n${details}` : "");

  await sendToUser(telegramId, message);
}

function truncate(s: string): string {
  if (!s || s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}
