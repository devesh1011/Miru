/**
 * Telegram Bot Commands
 *
 * All user-facing commands for DeepMirror.
 */

import { Telegraf, Markup } from "telegraf";
import type { BotContext } from "./index.js";
import { userRepo, positionRepo, orderRepo } from "../db/index.js";
import { positionManager } from "../services/position-manager.js";
import { deepBookService } from "../sui/deepbook.js";
import { suiService } from "../sui/client.js";
import { mirrorEngine } from "../services/mirror-engine.js";
import {
  getPools,
  getPoolSummaries,
  discoverTopMakers,
  getPoolOverview,
  type MakerProfile,
  type IndexerPool,
  type PoolSummary,
} from "../services/discover.js";

/**
 * Temporary in-memory cache for /discover button callbacks.
 * Maps short key (e.g. "d_0") → { poolName, balanceManagerId }
 * Entries expire after 10 minutes.
 */
const discoverCache = new Map<
  string,
  { poolName: string; balanceManagerId: string; expiresAt: number }
>();
let discoverCounter = 0;

function cacheDiscoverEntry(
  poolName: string,
  balanceManagerId: string,
): string {
  const key = `d_${discoverCounter++}`;
  // Wrap counter to avoid growing forever
  if (discoverCounter > 999_999) discoverCounter = 0;
  discoverCache.set(key, {
    poolName,
    balanceManagerId,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min TTL
  });
  return key;
}

function getDiscoverEntry(key: string) {
  const entry = discoverCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    discoverCache.delete(key);
    return null;
  }
  return entry;
}

/**
 * Register all commands on the bot
 */
export function registerCommands(bot: Telegraf<BotContext>): void {
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("copy", handleCopy);
  bot.command("positions", handlePositions);
  bot.command("stop", handleStop);
  bot.command("status", handleStatus);
  bot.command("balance", handleBalance);
  bot.command("link", handleLink);
  bot.command("discover", handleDiscover);
  bot.command("pools", handlePools);

  // Callback queries for inline buttons
  bot.action(/^stop_(.+)$/, handleStopConfirm);
  bot.action(/^cancel_stop$/, handleCancelStop);
  bot.action(/^copy_maker_(.+)$/, handleCopyMakerCallback);
}

// ──────────────────────────────────────────────
//  /start
// ──────────────────────────────────────────────

async function handleStart(ctx: BotContext): Promise<void> {
  const username = ctx.from?.first_name || "there";

  await ctx.replyWithMarkdownV2(
    escapeMarkdown(
      `🪞 Welcome to DeepMirror, ${username}!\n\n` +
        `DeepMirror automatically copies top liquidity providers on Sui's DeepBook CLOB.\n\n` +
        `🔑 How it works:\n` +
        `1. Link your Sui wallet\n` +
        `2. Pick a maker to copy\n` +
        `3. Set your ratio (e.g. 50%)\n` +
        `4. We mirror their orders automatically!\n\n` +
        `📋 Quick commands:\n` +
        `/pools - Browse available pools\n` +
        `/discover <pool> - Find top makers\n` +
        `/copy <maker_address> <pool> <ratio> - Start copying\n` +
        `/positions - View your active mirrors\n` +
        `/balance - Check your balance\n` +
        `/help - All commands\n\n` +
        `Get started with /pools or /help`,
    ),
  );
}

// ──────────────────────────────────────────────
//  /help
// ──────────────────────────────────────────────

async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.replyWithMarkdownV2(
    escapeMarkdown(
      `🪞 DeepMirror Commands\n\n` +
        `📌 Getting Started:\n` +
        `/start - Welcome message\n` +
        `/link <sui_address> - Link your Sui wallet\n\n` +
        `� Discovery:\n` +
        `/pools - Browse available DeepBook pools\n` +
        `/discover <pool> - Find top makers on a pool\n` +
        `  Example: /discover DEEP_SUI\n\n` +
        `📊 Trading:\n` +
        `/copy <maker> <pool> <ratio> - Start mirroring a maker\n` +
        `  Example: /copy 0xABC...DEF DEEP_SUI 50\n` +
        `  Ratio: 1-100 (% of maker's size)\n\n` +
        `📋 Management:\n` +
        `/positions - View active positions\n` +
        `/stop - Stop a position\n` +
        `/balance - Check wallet balance\n` +
        `/status - Service status\n\n` +
        `💡 Tips:\n` +
        `• Use /pools to see what's available\n` +
        `• Use /discover to find active makers\n` +
        `• Start with a small ratio (10-25%) to test\n` +
        `• Monitor your positions regularly\n` +
        `• You can stop mirroring any time with /stop`,
    ),
  );
}

// ──────────────────────────────────────────────
//  /link <sui_address>
// ──────────────────────────────────────────────

async function handleLink(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);

  if (args.length === 0) {
    const user = userRepo.getByTelegramId(telegramId);
    if (user?.sui_address) {
      await ctx.reply(
        `🔗 Your linked wallet:\n${user.sui_address}\n\nTo change, use: /link <new_address>`,
      );
    } else {
      await ctx.reply(
        `🔗 Link your Sui wallet:\n/link <your_sui_address>\n\nExample: /link 0x6db1...c9da`,
      );
    }
    return;
  }

  const suiAddress = args[0];

  // Basic validation
  if (!suiAddress.startsWith("0x") || suiAddress.length < 20) {
    await ctx.reply("❌ Invalid Sui address. Must start with 0x.");
    return;
  }

  userRepo.linkWallet(telegramId, suiAddress);

  await ctx.reply(
    `✅ Wallet linked!\n\n` +
      `Address: ${truncateAddress(suiAddress)}\n\n` +
      `You can now use /copy to start mirroring makers.`,
  );
}

// ──────────────────────────────────────────────
//  /copy <maker_address> <pool_key> <ratio>
// ──────────────────────────────────────────────

async function handleCopy(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);
  const args = getArgs(ctx);

  // Check wallet linked
  if (!user?.sui_address) {
    await ctx.reply(
      "⚠️ Please link your wallet first:\n/link <your_sui_address>",
    );
    return;
  }

  // Parse arguments
  if (args.length < 3) {
    await ctx.reply(
      `📝 Usage: /copy <maker_address> <pool> <ratio>\n\n` +
        `Example:\n/copy 0xABC...DEF DEEP_SUI 50\n\n` +
        `Pools: DEEP_SUI, SUI_USDC, DEEP_USDC\n` +
        `Ratio: 1-100 (percentage of maker's order size)`,
    );
    return;
  }

  const [makerAddress, poolKey, ratioStr] = args;
  const ratio = parseInt(ratioStr, 10);

  // Validate
  if (!makerAddress.startsWith("0x")) {
    await ctx.reply("❌ Invalid maker address. Must start with 0x.");
    return;
  }

  const validPools = ["DEEP_SUI", "SUI_USDC", "DEEP_USDC"];
  if (!validPools.includes(poolKey.toUpperCase())) {
    await ctx.reply(
      `❌ Invalid pool. Available pools:\n${validPools.join(", ")}`,
    );
    return;
  }

  if (isNaN(ratio) || ratio < 1 || ratio > 100) {
    await ctx.reply("❌ Ratio must be between 1 and 100.");
    return;
  }

  // Check if already copying this maker on this pool
  const existingPositions = positionRepo.getActiveByUser(telegramId);
  const duplicate = existingPositions.find(
    (p) =>
      p.target_maker === makerAddress && p.pool_key === poolKey.toUpperCase(),
  );

  if (duplicate) {
    await ctx.reply(
      `⚠️ You're already copying this maker on ${poolKey}.\n` +
        `Use /stop to cancel the existing position first.`,
    );
    return;
  }

  // Confirm to user
  await ctx.reply(
    `🔄 Setting up mirror position...\n\n` +
      `Maker: ${truncateAddress(makerAddress)}\n` +
      `Pool: ${poolKey.toUpperCase()}\n` +
      `Ratio: ${ratio}%\n\n` +
      `⏳ Creating on-chain position...`,
  );

  try {
    // Use a default balance manager key for MVP
    const balanceManagerKey = user.balance_manager_key || "MANAGER_1";

    const { positionId, txDigest } = await positionManager.createPosition({
      targetMaker: makerAddress,
      poolKey: poolKey.toUpperCase(),
      ratio,
      balanceManagerKey,
    });

    // Save to database
    positionRepo.create({
      id: positionId,
      userTelegramId: telegramId,
      targetMaker: makerAddress,
      poolKey: poolKey.toUpperCase(),
      ratio,
      balanceManagerKey,
    });

    await ctx.reply(
      `✅ Mirror position created!\n\n` +
        `📋 Position: ${truncateAddress(positionId)}\n` +
        `🎯 Maker: ${truncateAddress(makerAddress)}\n` +
        `📊 Pool: ${poolKey.toUpperCase()}\n` +
        `⚖️ Ratio: ${ratio}%\n` +
        `🔗 Tx: ${truncateAddress(txDigest)}\n\n` +
        `The bot will now automatically mirror this maker's orders.\n` +
        `Use /positions to check status.`,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Error creating position:", error);
    await ctx.reply(
      `❌ Failed to create position:\n${errMsg}\n\nPlease try again or check /status.`,
    );
  }
}

// ──────────────────────────────────────────────
//  /positions
// ──────────────────────────────────────────────

async function handlePositions(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const positions = positionRepo.getAllByUser(telegramId);

  if (positions.length === 0) {
    await ctx.reply(
      "📋 You have no positions yet.\n\nUse /copy to start mirroring a maker!",
    );
    return;
  }

  let message = "📋 *Your Positions*\n\n";

  for (const pos of positions) {
    const status = pos.is_active ? "🟢 Active" : "🔴 Stopped";
    const orders = orderRepo.getByPosition(pos.id);
    const recentOrders = orders.slice(0, 3);

    message +=
      `${status} *${pos.pool_key}*\n` +
      `  Maker: \`${truncateAddress(pos.target_maker)}\`\n` +
      `  Ratio: ${pos.ratio}%\n` +
      `  Orders placed: ${pos.total_orders_placed}\n` +
      `  ID: \`${truncateAddress(pos.id)}\`\n`;

    if (recentOrders.length > 0) {
      message += `  Recent:\n`;
      for (const ord of recentOrders) {
        const side = ord.is_bid ? "BID" : "ASK";
        message += `    ${side} ${ord.quantity} @ ${ord.price} (${ord.status})\n`;
      }
    }

    message += "\n";
  }

  message += `Use /stop to stop a position.`;

  await ctx.replyWithMarkdownV2(escapeMarkdown(message));
}

// ──────────────────────────────────────────────
//  /stop
// ──────────────────────────────────────────────

async function handleStop(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);

  const activePositions = positionRepo.getActiveByUser(telegramId);

  if (activePositions.length === 0) {
    await ctx.reply("📋 No active positions to stop.");
    return;
  }

  // If position ID provided directly
  if (args.length > 0) {
    const posId = args[0];
    const position = activePositions.find(
      (p) => p.id === posId || p.id.startsWith(posId),
    );

    if (!position) {
      await ctx.reply("❌ Position not found or already stopped.");
      return;
    }

    await stopPosition(ctx, position.id);
    return;
  }

  // Show inline buttons for each active position
  const buttons = activePositions.map((pos) =>
    Markup.button.callback(
      `${pos.pool_key} | ${truncateAddress(pos.target_maker)} | ${pos.ratio}%`,
      `stop_${pos.id}`,
    ),
  );

  buttons.push(Markup.button.callback("❌ Cancel", "cancel_stop"));

  await ctx.reply(
    "Which position do you want to stop?",
    Markup.inlineKeyboard(buttons, { columns: 1 }),
  );
}

async function handleStopConfirm(ctx: BotContext): Promise<void> {
  const match = (ctx as any).match;
  if (!match || !match[1]) return;

  const positionId = match[1];
  await ctx.answerCbQuery("Stopping position...");
  await ctx.editMessageText("⏳ Stopping position...");

  await stopPosition(ctx, positionId);
}

async function handleCancelStop(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Cancelled.");
}

async function stopPosition(
  ctx: BotContext,
  positionId: string,
): Promise<void> {
  try {
    const txDigest = await positionManager.pausePosition(positionId);
    positionRepo.setActive(positionId, false);

    await ctx.reply(
      `✅ Position stopped!\n\n` +
        `ID: ${truncateAddress(positionId)}\n` +
        `Tx: ${truncateAddress(txDigest)}\n\n` +
        `The bot will no longer mirror orders for this position.`,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Error stopping position:", error);
    await ctx.reply(`❌ Failed to stop position:\n${errMsg}`);
  }
}

// ──────────────────────────────────────────────
//  /status
// ──────────────────────────────────────────────

async function handleStatus(ctx: BotContext): Promise<void> {
  const engineStatus = mirrorEngine.getStatus();

  const msg =
    `📊 *DeepMirror Status*\n\n` +
    `🔧 *Engine:* ${engineStatus.isRunning ? "🟢 Running" : "🔴 Stopped"}\n` +
    `👁 *Tracked Makers:* ${engineStatus.trackedMakers}\n` +
    `📋 *Active Positions:* ${engineStatus.totalPositions}\n` +
    `🌐 *Network:* ${suiService.getNetwork()}\n`;

  await ctx.replyWithMarkdownV2(escapeMarkdown(msg));
}

// ──────────────────────────────────────────────
//  /balance
// ──────────────────────────────────────────────

async function handleBalance(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.sui_address) {
    await ctx.reply("⚠️ No wallet linked. Use /link <your_sui_address> first.");
    return;
  }

  await ctx.reply("⏳ Fetching balance...");

  try {
    const suiBalance = await suiService.getBalance(user.sui_address);
    const suiAmount = (parseInt(suiBalance) / 1_000_000_000).toFixed(4);

    let msg =
      `💰 *Wallet Balance*\n\n` +
      `Address: \`${truncateAddress(user.sui_address)}\`\n` +
      `SUI: ${suiAmount} SUI\n`;

    // If they have a balance manager, show DeepBook balances too
    if (user.balance_manager_key) {
      try {
        const deepBalance = await deepBookService.getManagerBalance(
          user.balance_manager_key,
          "DEEP",
        );
        msg += `\n📊 *DeepBook Manager:*\n`;
        msg += `DEEP: ${deepBalance.balance}\n`;
      } catch {
        // Balance manager might not have deposits yet
      }
    }

    await ctx.replyWithMarkdownV2(escapeMarkdown(msg));
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    await ctx.reply(`❌ Failed to fetch balance:\n${errMsg}`);
  }
}

// ──────────────────────────────────────────────
//  /pools
// ──────────────────────────────────────────────

async function handlePools(ctx: BotContext): Promise<void> {
  await ctx.reply("🔍 Fetching available pools...");

  try {
    const [pools, summaries] = await Promise.all([
      getPools(),
      getPoolSummaries().catch(() => [] as PoolSummary[]),
    ]);

    if (!pools || pools.length === 0) {
      await ctx.reply("No pools found on the indexer. Try again later.");
      return;
    }

    // Build a summary map for quick lookup
    const summaryMap = new Map<string, PoolSummary>();
    for (const s of summaries) {
      summaryMap.set(s.trading_pairs, s);
    }

    let msg = `📊 *DeepBook Pools* (${pools.length} available)\n\n`;

    for (const pool of pools.slice(0, 15)) {
      const s = summaryMap.get(pool.pool_name);
      msg += `*${pool.pool_name}*\n`;
      msg += `  ${pool.base_asset_symbol}/${pool.quote_asset_symbol}\n`;

      if (s) {
        const vol = s.base_volume > 0 ? formatNumber(s.base_volume) : "0";
        const price = s.last_price > 0 ? formatPrice(s.last_price) : "N/A";
        const change = s.price_change_percent_24h;
        const changeStr =
          change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
        msg += `  Price: ${price} | 24h Vol: ${vol} | ${changeStr}\n`;
      }
      msg += `  → /discover ${pool.pool_name}\n\n`;
    }

    if (pools.length > 15) {
      msg += `... and ${pools.length - 15} more pools\n`;
    }

    msg += `\n💡 Use /discover <pool_name> to find top makers`;

    await ctx.replyWithMarkdownV2(escapeMarkdown(msg));
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Error fetching pools:", error);
    await ctx.reply(`❌ Failed to fetch pools:\n${errMsg}`);
  }
}

// ──────────────────────────────────────────────
//  /discover <pool_name>
// ──────────────────────────────────────────────

async function handleDiscover(ctx: BotContext): Promise<void> {
  const args = getArgs(ctx);

  if (args.length === 0) {
    await ctx.reply(
      `🔍 Usage: /discover <pool_name>\n\n` +
        `Example: /discover DEEP_SUI\n\n` +
        `Use /pools to see available pools.`,
    );
    return;
  }

  const poolName = args[0].toUpperCase();
  const limit = args[1] ? parseInt(args[1], 10) : 5;

  await ctx.reply(`🔍 Scanning ${poolName} for top makers...`);

  try {
    const overview = await getPoolOverview(poolName);

    // Pool summary header
    let msg = `🔍 *${poolName} — Maker Discovery*\n\n`;

    if (overview.summary) {
      const s = overview.summary;
      const price = s.last_price > 0 ? formatPrice(s.last_price) : "N/A";
      const vol = s.base_volume > 0 ? formatNumber(s.base_volume) : "0";
      const spread =
        s.lowest_ask > 0 && s.highest_bid > 0
          ? (((s.lowest_ask - s.highest_bid) / s.last_price) * 100).toFixed(3)
          : "N/A";
      msg +=
        `📈 Price: ${price}\n` +
        `📊 24h Volume: ${vol}\n` +
        `📐 Spread: ${spread}%\n` +
        `📚 Book: ${overview.orderBookDepth.bids} bids / ${overview.orderBookDepth.asks} asks\n\n`;
    }

    // Top makers
    if (overview.topMakers.length === 0) {
      msg +=
        `⚠️ No active makers found in the last 24h.\n` +
        `This pool may have low activity on testnet.\n`;
    } else {
      msg += `🏆 *Top Makers (by volume)*\n\n`;

      for (let i = 0; i < overview.topMakers.length; i++) {
        const m = overview.topMakers[i];
        const medal =
          i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
        const bmShort = truncateAddress(m.balanceManagerId);

        msg +=
          `${medal} *${bmShort}*\n` +
          `  📦 Orders: ${m.orderCount} (${m.buyOrders}B/${m.sellOrders}S)\n` +
          `  💰 Volume: ${formatNumber(m.totalVolume)}\n` +
          `  📊 Fill Rate: ${m.fillRate.toFixed(1)}%\n` +
          `  💲 Avg Price: ${formatPrice(m.avgPrice)}\n` +
          `  📏 Price Range: ${formatPrice(m.priceRange.low)} - ${formatPrice(m.priceRange.high)}\n\n`;
      }
    }

    await ctx.replyWithMarkdownV2(escapeMarkdown(msg));

    // Send copyable inline buttons for each maker
    // NOTE: Telegram callback_data has a 64-byte limit, so we use
    //       short cache keys instead of full Sui addresses.
    if (overview.topMakers.length > 0) {
      const buttons = overview.topMakers.map((m, i) => {
        const medal =
          i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
        const cacheKey = cacheDiscoverEntry(poolName, m.balanceManagerId);
        return Markup.button.callback(
          `${medal} Copy ${truncateAddress(m.balanceManagerId)} (${m.orderCount} orders)`,
          `copy_maker_${cacheKey}`,
        );
      });

      await ctx.reply(
        `⬇️ Tap a maker to start copying on ${poolName}:`,
        Markup.inlineKeyboard(buttons, { columns: 1 }),
      );
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Error discovering makers:", error);
    await ctx.reply(
      `❌ Failed to discover makers on ${poolName}:\n${errMsg}\n\n` +
        `Make sure the pool name is correct. Use /pools to see available pools.`,
    );
  }
}

// ──────────────────────────────────────────────
//  Callback: Copy Maker (from /discover buttons)
// ──────────────────────────────────────────────

async function handleCopyMakerCallback(ctx: BotContext): Promise<void> {
  const match = (ctx as any).match;
  if (!match || !match[1]) return;

  // Payload is a short cache key like "d_42"
  const cacheKey = match[1] as string;
  const entry = getDiscoverEntry(cacheKey);

  if (!entry) {
    await ctx.answerCbQuery("⏰ Selection expired. Run /discover again.");
    return;
  }

  const { poolName, balanceManagerId } = entry;

  await ctx.answerCbQuery("Setting up copy...");

  // Send the maker's full address so user can proceed (use plain text to avoid MarkdownV2 escaping issues)
  const msg =
    `📋 Maker Details\n\n` +
    `Pool: ${poolName}\n` +
    `Balance Manager ID:\n${balanceManagerId}\n\n` +
    `To start copying, run:\n` +
    `/copy ${balanceManagerId} ${poolName} 25\n\n` +
    `💡 Adjust the ratio (25) to your preference (1-100).`;

  await ctx.reply(msg);
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Extract command arguments from message text
 */
function getArgs(ctx: BotContext): string[] {
  const text = (ctx.message as any)?.text || "";
  const parts = text.split(/\s+/).slice(1); // Remove the /command part
  return parts;
}

/**
 * Truncate a hex address for display
 */
function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

/**
 * Escape special characters for Telegram MarkdownV2
 */
function escapeMarkdown(text: string): string {
  // MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/([_\[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}

/**
 * Format a large number with K/M/B suffixes
 */
function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toFixed(2);
}

/**
 * Format a price with appropriate decimal places
 */
function formatPrice(price: number): string {
  if (price === 0) return "0";
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}
