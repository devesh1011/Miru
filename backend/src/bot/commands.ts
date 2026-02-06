/**
 * Telegram Bot Commands
 *
 * All user-facing commands for DeepMirror.
 */

import { Telegraf, Markup } from "telegraf";
import type { BotContext } from "./index.js";
import {
  userRepo,
  positionRepo,
  orderRepo,
  capabilityRepo,
} from "../db/index.js";
import { positionManager } from "../services/position-manager.js";
import { deepBookService } from "../sui/deepbook.js";
import { suiService } from "../sui/client.js";
import { mirrorEngine } from "../services/mirror-engine.js";
import { zkLoginService } from "../services/zklogin.js";
import { txBuilderService } from "../services/tx-builder.js";
import {
  getPools,
  getPoolSummaries,
  discoverTopMakers,
  getPoolOverview,
  type MakerProfile,
  type IndexerPool,
  type PoolSummary,
} from "../services/discover.js";
import {
  parseSuiError,
  parseZkLoginError,
  formatErrorForUser,
  formatErrorVerbose,
  checkGasBalance,
  checkWithdrawBalance,
  validateSuiAddress,
  validateRatio,
  extractErrorMessage,
  ErrorCategory,
  type ParsedError,
} from "../utils/errors.js";

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
  // Non-custodial zkLogin commands
  bot.command("connect", handleConnect);
  bot.command("wallet", handleWallet);
  bot.command("grant", handleGrant);
  bot.command("revoke", handleRevoke);
  bot.command("auth", handleAuth);
  bot.command("deposit", handleDeposit);
  bot.command("withdraw", handleWithdraw);

  // Callback queries for inline buttons
  bot.action(/^stop_(.+)$/, handleStopConfirm);
  bot.action(/^cancel_stop$/, handleCancelStop);
  bot.action(/^copy_maker_(.+)$/, handleCopyMakerCallback);
  bot.action(/^auth_jwt_(.+)$/, handleAuthJwtCallback);
}

// ──────────────────────────────────────────────
//  /start
// ──────────────────────────────────────────────

async function handleStart(ctx: BotContext): Promise<void> {
  const username = ctx.from?.first_name || "there";

  await ctx.replyWithMarkdownV2(
    escapeMarkdown(
      `🪞 Welcome to Miru, ${username}!\n\n` +
        `Miru automatically copies top liquidity providers on Sui's DeepBook CLOB — fully non-custodial.\n\n` +
        `🔐 How it works:\n` +
        `1. Connect via Google (zkLogin) — /connect\n` +
        `2. Pick a maker to copy — /discover\n` +
        `3. Set your ratio (e.g. 50%)\n` +
        `4. Grant the bot permission to mirror orders\n` +
        `5. We mirror their orders automatically!\n\n` +
        `📋 Quick commands:\n` +
        `/connect - Sign in with Google (zkLogin)\n` +
        `/pools - Browse available pools\n` +
        `/discover <pool> - Find top makers\n` +
        `/copy <maker> <pool> <ratio> - Start copying\n` +
        `/positions - View your active mirrors\n` +
        `/wallet - View your wallet\n` +
        `/help - All commands\n\n` +
        `Get started with /connect`,
    ),
  );
}

// ──────────────────────────────────────────────
//  /help
// ──────────────────────────────────────────────

async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.replyWithMarkdownV2(
    escapeMarkdown(
      `\u{1FA9E} Miru Commands\n\n` +
        `\u{1F510} Wallet:\n` +
        `/connect - Sign in with Google (zkLogin)\n` +
        `/wallet - View your zkLogin wallet\n` +
        `/link <sui_address> - Link external wallet\n\n` +
        `\u{1F50D} Discovery:\n` +
        `/pools - Browse available DeepBook pools\n` +
        `/discover <pool> - Find top makers on a pool\n` +
        `  Example: /discover DEEP_SUI\n\n` +
        `\u{1F4CA} Trading:\n` +
        `/copy <maker> <pool> <ratio> - Start mirroring\n` +
        `  Example: /copy 0xABC...DEF DEEP_SUI 50\n` +
        `  Ratio: 1-100 (% of maker's size)\n\n` +
        `\u{1F4CB} Management:\n` +
        `/positions - View active positions\n` +
        `/stop - Stop a position\n` +
        `/balance - Check wallet balance\n` +
        `/deposit - Fund your zkLogin wallet\n` +
        `/withdraw <amount> <to> - Send SUI from wallet\n` +
        `/status - Service status\n\n` +
        `\u{1F511} Permissions:\n` +
        `/grant <position_id> - Grant bot permission to mirror\n` +
        `/revoke <position_id> - Revoke bot permission\n\n` +
        `\u{1F4A1} Tips:\n` +
        `\u2022 Use /connect to create a non-custodial wallet\n` +
        `\u2022 Use /discover to find active makers\n` +
        `\u2022 Start with a small ratio (10-25%) to test\n` +
        `\u2022 You control your funds \u2014 revoke access anytime`,
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

  // Validate address format
  const addrError = validateSuiAddress(suiAddress);
  if (addrError) {
    await ctx.reply(`❌ ${addrError}`);
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

  // Validate maker address
  const addrError = validateSuiAddress(makerAddress);
  if (addrError) {
    await ctx.reply(`❌ Invalid maker address: ${addrError}`);
    return;
  }

  const validPools = ["DEEP_SUI", "SUI_USDC", "DEEP_USDC"];
  if (!validPools.includes(poolKey.toUpperCase())) {
    await ctx.reply(
      `❌ Invalid pool. Available pools:\n${validPools.join(", ")}\n\n💡 Use /pools to see all available pools.`,
    );
    return;
  }

  // Validate ratio
  const ratioError = validateRatio(ratioStr);
  if (ratioError) {
    await ctx.reply(`❌ ${ratioError}`);
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
    // Determine flow: zkLogin (non-custodial) vs legacy (custodial)
    const hasZkLogin =
      user.zklogin_address && (await zkLoginService.isSessionValid(telegramId));

    if (hasZkLogin) {
      // ── Non-custodial flow: user signs via zkLogin ──

      // Pre-check: verify zkLogin wallet has enough SUI for gas
      try {
        const rawBalance = await suiService.getBalance(user.zklogin_address!);
        const gasCheck = checkGasBalance(rawBalance, "Your zkLogin wallet");
        if (gasCheck) {
          await ctx.reply(gasCheck);
          return;
        }
      } catch (balanceErr) {
        console.warn("Could not pre-check balance:", balanceErr);
        // Continue anyway — the transaction will fail with a clear error if no gas
      }
      const poolId = await deepBookService.getPoolId(poolKey.toUpperCase());
      const operatorAddress = txBuilderService.getOperatorAddress();
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

      const result = await zkLoginService.signAndExecuteFull(
        telegramId,
        txBuilderService.buildCreatePositionAndGrant(
          user.zklogin_address!,
          makerAddress,
          ratio,
          poolId,
          operatorAddress,
          0, // unlimited order size
          expiresAt,
        ),
      );

      // Extract created object IDs from transaction result
      const { positionId, capabilityId } = extractCreatedObjects(
        result.objectChanges,
      );

      if (!positionId) {
        throw new Error(
          "Position not found in transaction result. Tx: " + result.digest,
        );
      }

      // Save position to database
      const balanceManagerKey = user.balance_manager_key || "MANAGER_1";
      positionRepo.create({
        id: positionId,
        userTelegramId: telegramId,
        targetMaker: makerAddress,
        poolKey: poolKey.toUpperCase(),
        poolId,
        ratio,
        balanceManagerKey,
      });

      // Save capability if found
      if (capabilityId) {
        capabilityRepo.create({
          id: capabilityId,
          positionId,
          userTelegramId: telegramId,
          operatorAddress,
          maxOrderSize: "0",
          expiresAt,
        });
      }

      // Register with mirror engine (includes capability for delegated recording)
      mirrorEngine.registerPosition({
        positionId,
        owner: user.zklogin_address!,
        targetMaker: makerAddress,
        poolKey: poolKey.toUpperCase(),
        ratio,
        active: true,
        balanceManagerKey,
        capabilityId: capabilityId || undefined,
      });

      // Subscribe to pool events
      const { eventMonitor } = await import("../services/event-monitor.js");
      eventMonitor.subscribeToPool(poolKey.toUpperCase(), poolId, [
        makerAddress,
      ]);

      await ctx.reply(
        `✅ Mirror position created (non-custodial)!\n\n` +
          `📋 Position: ${truncateAddress(positionId)}\n` +
          `🎯 Maker: ${truncateAddress(makerAddress)}\n` +
          `📊 Pool: ${poolKey.toUpperCase()}\n` +
          `⚖️ Ratio: ${ratio}%\n` +
          `🔗 Tx: ${truncateAddress(result.digest)}\n` +
          (capabilityId
            ? `🔑 Capability: ${truncateAddress(capabilityId)}\n`
            : "") +
          `\nYou own this position. The bot mirrors orders via a granted capability.\n` +
          `Use /positions to check status, /revoke to remove bot access.`,
      );
    } else {
      // ── Legacy custodial flow ──
      const balanceManagerKey = user.balance_manager_key || "MANAGER_1";

      const { positionId, txDigest } = await positionManager.createPosition({
        targetMaker: makerAddress,
        poolKey: poolKey.toUpperCase(),
        ratio,
        balanceManagerKey,
      });

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
    }
  } catch (error) {
    console.error("Error creating position:", error);
    const parsed = parseZkLoginError(error);

    // Give specific guidance based on error type
    let reply = formatErrorForUser(parsed);

    if (parsed.category === ErrorCategory.INSUFFICIENT_GAS) {
      reply +=
        "\n\n📋 Your zkLogin wallet address:\n" +
        (user.zklogin_address || "(use /wallet to see)");
    } else if (parsed.category === ErrorCategory.SESSION_EXPIRED) {
      reply += "\n\n🔄 Run /connect to start a new session.";
    } else if (parsed.category === ErrorCategory.OBJECT_NOT_FOUND) {
      reply +=
        "\n\n🔧 The pool or contract object may not exist on this network.";
    }

    await ctx.reply(reply);
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
    console.error("Error stopping position:", error);
    const parsed = parseSuiError(error);
    await ctx.reply(
      `❌ Failed to stop position.\n\n${formatErrorForUser(parsed)}`,
    );
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
    console.error("Error fetching balance:", error);
    const parsed = parseSuiError(error);
    await ctx.reply(formatErrorForUser(parsed));
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
      await ctx.reply(
        "📊 No pools found on the indexer.\n\n💡 The indexer may be temporarily unavailable. Try again in a moment.",
      );
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
    console.error("Error fetching pools:", error);
    const parsed = parseSuiError(error);
    if (
      parsed.category === ErrorCategory.NETWORK_ERROR ||
      parsed.category === ErrorCategory.TIMEOUT
    ) {
      await ctx.reply(
        "❌ Could not reach the DeepBook indexer.\n\n💡 The indexer may be temporarily down. Try again in a few seconds.",
      );
    } else {
      await ctx.reply(formatErrorForUser(parsed));
    }
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
    console.error("Error discovering makers:", error);
    const parsed = parseSuiError(error);
    if (
      parsed.category === ErrorCategory.NETWORK_ERROR ||
      parsed.category === ErrorCategory.TIMEOUT
    ) {
      await ctx.reply(
        `❌ Could not reach the DeepBook indexer for ${poolName}.\n\n` +
          `💡 The indexer may be temporarily unavailable. Try again shortly.`,
      );
    } else {
      await ctx.reply(
        `❌ Failed to discover makers on ${poolName}.\n\n${formatErrorForUser(parsed)}\n\n` +
          `Make sure the pool name is correct. Use /pools to see available pools.`,
      );
    }
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
//  /connect - zkLogin OAuth flow
// ──────────────────────────────────────────────

/**
 * In-memory store for JWT submission.
 * Maps short key → telegramId for the auth_jwt callback.
 */
const jwtPendingMap = new Map<
  string,
  { telegramId: string; expiresAt: number }
>();
let jwtCounter = 0;

async function handleConnect(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();

  try {
    // Check if already connected
    const user = userRepo.getByTelegramId(telegramId);
    if (user?.zklogin_address) {
      const valid = await zkLoginService.isSessionValid(telegramId);
      if (valid) {
        await ctx.reply(
          `🔐 Already connected!\n\n` +
            `Address: ${truncateAddress(user.zklogin_address)}\n\n` +
            `Use /wallet to see details, or /connect again to re-authenticate.`,
        );
        // Don't return — allow re-auth
      }
    }

    await ctx.reply("🔄 Initializing zkLogin session...");

    // Initialize zkLogin session
    const { nonce, oauthUrl } = await zkLoginService.initSession(telegramId);

    // Store a pending JWT key for this user
    const jwtKey = `j_${jwtCounter++}`;
    if (jwtCounter > 999_999) jwtCounter = 0;
    jwtPendingMap.set(jwtKey, {
      telegramId,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
    });

    await ctx.reply(
      `🔐 Sign in with Google\n\n` +
        `Click the button below to authenticate:\n`,
      Markup.inlineKeyboard([
        [Markup.button.url("🔑 Sign in with Google", oauthUrl)],
      ]),
    );

    await ctx.reply(
      `After signing in, you'll be redirected to a page with your JWT token.\n\n` +
        `Copy the token and send it here as:\n` +
        `/auth <your_jwt_token>\n\n` +
        `⏱ This link expires in 10 minutes.`,
    );
  } catch (error: any) {
    console.error("Connect error:", error);
    const parsed = parseZkLoginError(error);
    if (
      parsed.category === ErrorCategory.NETWORK_ERROR ||
      parsed.category === ErrorCategory.TIMEOUT
    ) {
      await ctx.reply(
        "❌ Could not connect to the Sui network to initialize your session.\n\n" +
          "💡 The RPC node may be temporarily slow. Please try again in a few seconds.",
      );
    } else {
      await ctx.reply(formatErrorForUser(parsed));
    }
  }
}

// ──────────────────────────────────────────────
//  /auth <jwt_token> - Submit JWT from OAuth callback
// ──────────────────────────────────────────────

async function handleAuth(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);

  if (args.length < 1) {
    await ctx.reply(
      "Usage: /auth <jwt_token>\n\n" +
        "Paste the JWT token from the Google sign-in redirect.",
    );
    return;
  }

  const jwt = args[0];

  try {
    await ctx.reply("🔄 Processing authentication...");

    const { address, sub } = await zkLoginService.processJwtCallback(
      telegramId,
      jwt,
    );

    await ctx.reply(
      `✅ Wallet connected!\n\n` +
        `Your Sui address:\n${address}\n\n` +
        `This address is derived from your Google identity via zkLogin.\n` +
        `No one — not even the bot — can access your funds without your approval.\n\n` +
        `Next steps:\n` +
        `• /pools - Browse available pools\n` +
        `• /discover <pool> - Find makers to copy\n` +
        `• /balance - Check your balance\n` +
        `• /wallet - View wallet details`,
    );
  } catch (error: any) {
    console.error("Auth error:", error);
    const parsed = parseZkLoginError(error);

    let reply = formatErrorForUser(parsed);
    if (parsed.category === ErrorCategory.INVALID_INPUT) {
      reply +=
        "\n\n📝 Make sure you:\n" +
        "1. Copied the FULL token from the callback page\n" +
        "2. Didn't add extra spaces or characters\n" +
        "3. The token hasn't expired (use /connect for a fresh one)";
    } else if (parsed.category === ErrorCategory.PROVER_ERROR) {
      reply += "\n\n🔄 Try /connect to start a fresh authentication flow.";
    } else if (parsed.category === ErrorCategory.SESSION_MISSING) {
      reply += "\n\n🔄 Use /connect first, then sign in with Google.";
    }

    await ctx.reply(reply);
  }
}

// We need to handle this as a text message since the JWT is very long
// Register it in the registerCommands function via bot.command
async function handleAuthJwtCallback(ctx: any): Promise<void> {
  // This handles the callback query from inline buttons (not used for JWT)
  await ctx.answerCbQuery("Processing...");
}

// ──────────────────────────────────────────────
//  /wallet - View zkLogin wallet details
// ──────────────────────────────────────────────

async function handleWallet(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ No wallet connected.\n\nUse /connect to sign in with Google and create your wallet.",
    );
    return;
  }

  try {
    const valid = await zkLoginService.isSessionValid(telegramId);
    let balance = "N/A";
    try {
      const rawBalance = await suiService.getBalance(user.zklogin_address);
      const suiBalance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4);
      balance = `${suiBalance} SUI`;
    } catch {
      balance = "Unable to fetch";
    }

    await ctx.reply(
      `🔐 Your Wallet\n\n` +
        `Address: ${user.zklogin_address}\n` +
        `Balance: ${balance}\n` +
        `Session: ${valid ? "✅ Active" : "❌ Expired (re-connect with /connect)"}\n` +
        `Auth: Google (zkLogin)\n\n` +
        `This is a non-custodial wallet. Only you can sign transactions.`,
    );
  } catch (error: any) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// ──────────────────────────────────────────────
//  /grant <position_id> - Grant bot capability
// ──────────────────────────────────────────────

async function handleGrant(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply("⚠️ Connect your wallet first with /connect");
    return;
  }

  if (args.length < 1) {
    await ctx.reply(
      "Usage: /grant <position_id>\n\n" +
        "This grants the bot permission to mirror orders on your position.\n" +
        "You can revoke this anytime with /revoke.",
    );
    return;
  }

  const positionId = args[0];

  try {
    const valid = await zkLoginService.isSessionValid(telegramId);
    if (!valid) {
      await ctx.reply(
        "❌ Session expired. Please re-authenticate with /connect",
      );
      return;
    }

    await ctx.reply("🔄 Granting bot capability...");

    const operatorAddress = txBuilderService.getOperatorAddress();

    // 30-day expiry (ms)
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

    // Build & sign with zkLogin (full result to extract capability ID)
    const result = await zkLoginService.signAndExecuteFull(
      telegramId,
      txBuilderService.buildGrantCapability(
        positionId,
        operatorAddress,
        0, // unlimited order size
        expiresAt,
      ),
    );

    // Extract the real on-chain capability ID
    const { capabilityId } = extractCreatedObjects(result.objectChanges);

    capabilityRepo.create({
      id: capabilityId || `cap_${Date.now()}`,
      positionId,
      userTelegramId: telegramId,
      operatorAddress,
      maxOrderSize: "0",
      expiresAt,
    });

    // Update the tracked position in the mirror engine with the new capability
    const trackedPos = mirrorEngine.findTrackedPosition(positionId);
    if (trackedPos && capabilityId) {
      trackedPos.capabilityId = capabilityId;
    }

    await ctx.reply(
      `✅ Capability granted!\n\n` +
        `Position: ${truncateAddress(positionId)}\n` +
        `Operator: ${truncateAddress(operatorAddress)}\n` +
        (capabilityId ? `Capability: ${truncateAddress(capabilityId)}\n` : "") +
        `Expires: 30 days\n` +
        `Tx: ${truncateAddress(result.digest)}\n\n` +
        `The bot can now mirror orders on this position.\n` +
        `Revoke anytime with /revoke ${truncateAddress(positionId)}`,
    );
  } catch (error: any) {
    console.error("Grant error:", error);
    await ctx.reply(`❌ Failed to grant capability: ${error.message}`);
  }
}

// ──────────────────────────────────────────────
//  /revoke <position_id> - Revoke bot capability
// ──────────────────────────────────────────────

async function handleRevoke(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply("⚠️ Connect your wallet first with /connect");
    return;
  }

  if (args.length < 1) {
    // Show active capabilities
    const caps = capabilityRepo.getByUser(telegramId);
    if (caps.length === 0) {
      await ctx.reply("No active capabilities found.");
      return;
    }

    let msg = "🔑 Active Capabilities:\n\n";
    for (const cap of caps) {
      msg += `Position: ${truncateAddress(cap.position_id)}\n`;
      msg += `Cap ID: ${truncateAddress(cap.id)}\n`;
      msg += `Expires: ${cap.expires_at > 0 ? new Date(cap.expires_at).toLocaleDateString() : "Never"}\n\n`;
    }
    msg += "To revoke: /revoke <position_id>";

    await ctx.reply(msg);
    return;
  }

  const positionId = args[0];

  try {
    // Find capability for this position
    const cap = capabilityRepo.getByPosition(positionId);
    if (!cap) {
      await ctx.reply("❌ No active capability found for this position.");
      return;
    }

    // Deactivate in DB
    capabilityRepo.deactivate(cap.id);

    await ctx.reply(
      `✅ Capability revoked!\n\n` +
        `Position: ${truncateAddress(positionId)}\n` +
        `The bot can no longer mirror orders on this position.`,
    );
  } catch (error: any) {
    console.error("Revoke error:", error);
    await ctx.reply(`❌ Failed to revoke capability: ${error.message}`);
  }
}

// ──────────────────────────────────────────────
//  /deposit - Fund your zkLogin wallet
// ──────────────────────────────────────────────

async function handleDeposit(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ No wallet connected.\n\nUse /connect to sign in with Google and create your wallet first.",
    );
    return;
  }

  try {
    let balance = "N/A";
    try {
      const rawBalance = await suiService.getBalance(user.zklogin_address);
      balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
    } catch {
      balance = "Unable to fetch";
    }

    await ctx.reply(
      `💰 Deposit to your Miru wallet\n\n` +
        `Your address:\n${user.zklogin_address}\n\n` +
        `Current balance: ${balance}\n\n` +
        `To deposit, send SUI to the address above from any Sui wallet.\n\n` +
        `💡 You need SUI in this wallet for:\n` +
        `• Gas fees when creating positions\n` +
        `• Gas fees when granting/revoking capabilities\n\n` +
        `Tip: Copy the address above and paste it in your Sui wallet's send screen.`,
    );
  } catch (error: any) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// ──────────────────────────────────────────────
//  /withdraw <amount> <recipient> - Send SUI from zkLogin wallet
// ──────────────────────────────────────────────

async function handleWithdraw(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);
  const args = getArgs(ctx);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ No wallet connected.\n\nUse /connect to sign in with Google first.",
    );
    return;
  }

  if (args.length < 2) {
    // Show balance and usage
    let balance = "N/A";
    try {
      const rawBalance = await suiService.getBalance(user.zklogin_address);
      balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
    } catch {
      /* ignore */
    }

    await ctx.reply(
      `📤 Withdraw SUI from your wallet\n\n` +
        `Current balance: ${balance}\n\n` +
        `Usage: /withdraw <amount_sui> <recipient_address>\n\n` +
        `Example:\n/withdraw 1.5 0xABC...DEF\n\n` +
        `This will send SUI from your zkLogin wallet to the recipient.`,
    );
    return;
  }

  const amountStr = args[0];
  const recipient = args[1];
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || amount <= 0) {
    await ctx.reply("❌ Invalid amount. Must be a positive number.");
    return;
  }

  if (!recipient.startsWith("0x") || recipient.length < 10) {
    await ctx.reply("❌ Invalid recipient address. Must start with 0x.");
    return;
  }

  try {
    const valid = await zkLoginService.isSessionValid(telegramId);
    if (!valid) {
      await ctx.reply(
        "❌ Session expired. Please re-authenticate with /connect",
      );
      return;
    }

    await ctx.reply(
      `⏳ Sending ${amount} SUI to ${truncateAddress(recipient)}...`,
    );

    // Build a SUI transfer transaction and sign with zkLogin
    const amountMist = Math.floor(amount * 1_000_000_000);
    const digest = await zkLoginService.signAndExecute(telegramId, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [amountMist]);
      tx.transferObjects([coin], recipient);
    });

    await ctx.reply(
      `✅ Withdrawal complete!\n\n` +
        `Amount: ${amount} SUI\n` +
        `To: ${truncateAddress(recipient)}\n` +
        `Tx: ${truncateAddress(digest)}\n\n` +
        `Use /wallet to check your updated balance.`,
    );
  } catch (error: any) {
    console.error("Withdraw error:", error);
    await ctx.reply(`❌ Withdrawal failed: ${error.message}`);
  }
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Extract MirrorPosition and MirrorCapability IDs from transaction objectChanges.
 * The JSON-RPC `executeTransactionBlock` with `showObjectChanges: true`
 * returns an array of { type: "created"|"mutated", objectType, objectId, ... }.
 */
function extractCreatedObjects(objectChanges?: any[]): {
  positionId: string | null;
  capabilityId: string | null;
} {
  let positionId: string | null = null;
  let capabilityId: string | null = null;

  if (!objectChanges) return { positionId, capabilityId };

  for (const change of objectChanges) {
    if (change.type !== "created") continue;
    const objType: string = change.objectType || "";
    if (objType.includes("MirrorPosition")) {
      positionId = change.objectId;
    } else if (objType.includes("MirrorCapability")) {
      capabilityId = change.objectId;
    }
  }

  return { positionId, capabilityId };
}

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
