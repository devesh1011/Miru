/**
 * DeepMirror Telegram Bot
 *
 * Main bot setup using Telegraf.
 * Handles user commands for copy-trading on Sui DeepBook.
 */

import { Telegraf, Context, Markup } from "telegraf";
import { config } from "../config/index.js";
import { userRepo } from "../db/index.js";
import { registerCommands } from "./commands.js";

/**
 * Extended context with user data
 */
export interface BotContext extends Context {
  /** DB user record (populated by middleware) */
  dbUser?: ReturnType<typeof userRepo.findOrCreate>;
}

let bot: Telegraf<BotContext> | null = null;

/**
 * Create and configure the Telegram bot
 */
export function createBot(): Telegraf<BotContext> {
  const token = config.telegram.botToken;

  if (!token || token === "your_bot_token_here") {
    throw new Error(
      "TELEGRAM_BOT_TOKEN not configured. Get one from @BotFather on Telegram.",
    );
  }

  bot = new Telegraf<BotContext>(token);

  // ── Middleware ──────────────────────────────

  // Ensure user exists in DB for every message
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      ctx.dbUser = userRepo.findOrCreate(
        ctx.from.id.toString(),
        ctx.from.username,
      );
    }
    return next();
  });

  // Error handler
  bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err);
    ctx.reply("❌ Something went wrong. Please try again.").catch(() => {});
  });

  // ── Register Commands ──────────────────────
  registerCommands(bot);

  return bot;
}

/**
 * Start the bot (long polling mode)
 */
export async function startBot(): Promise<void> {
  if (!bot) {
    throw new Error("Bot not created. Call createBot() first.");
  }

  // Set bot commands menu
  await bot.telegram.setMyCommands([
    { command: "start", description: "Get started with Miru" },
    { command: "connect", description: "Sign in with Google (zkLogin)" },
    { command: "wallet", description: "View your wallet" },
    { command: "help", description: "Show all commands" },
    { command: "pools", description: "Browse available DeepBook pools" },
    { command: "discover", description: "Find top makers on a pool" },
    { command: "copy", description: "Start copying a maker" },
    { command: "positions", description: "View your active positions" },
    { command: "stop", description: "Stop a position" },
    { command: "grant", description: "Grant bot permission to mirror" },
    { command: "revoke", description: "Revoke bot permission" },
    { command: "deposit", description: "Fund your zkLogin wallet" },
    { command: "withdraw", description: "Send SUI from your wallet" },
    { command: "balance", description: "Check your balance" },
    { command: "status", description: "Bot and service status" },
  ]);

  // Launch with long polling
  await bot.launch();
  console.log("🤖 Telegram bot started");
}

/**
 * Stop the bot gracefully
 */
export function stopBot(): void {
  if (bot) {
    bot.stop("SIGTERM");
    console.log("🤖 Telegram bot stopped");
  }
}

/**
 * Get the bot instance (for sending notifications)
 */
export function getBot(): Telegraf<BotContext> | null {
  return bot;
}
