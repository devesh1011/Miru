/**
 * Telegram Bot Commands — Menu-Driven Interface
 *
 * UX: users interact via inline keyboard buttons
 * instead of slash commands. /start shows a main menu, each option
 * opens a submenu, and data-entry happens via reply prompts.
 *
 * Slash commands still work as fallbacks, but the primary UX is buttons.
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

// ──────────────────────────────────────────────
//  In-memory caches
// ──────────────────────────────────────────────

/** Discover results cache — maps "d_<n>" → maker data */
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
  if (discoverCounter > 999_999) discoverCounter = 0;
  discoverCache.set(key, {
    poolName,
    balanceManagerId,
    expiresAt: Date.now() + 10 * 60 * 1000,
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

/** Position cache — maps "p_<n>" → position ID (to avoid 64-byte Telegram limit) */
const positionCache = new Map<
  string,
  { positionId: string; expiresAt: number }
>();
let positionCounter = 0;

function cachePositionId(positionId: string): string {
  const key = `p_${positionCounter++}`;
  if (positionCounter > 999_999) positionCounter = 0;
  positionCache.set(key, {
    positionId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return key;
}

function getPositionId(key: string): string | null {
  const entry = positionCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    positionCache.delete(key);
    return null;
  }
  return entry.positionId;
}

/** Capability cache — maps "c_<n>" → capability ID (to avoid 64-byte Telegram limit) */
const capabilityCache = new Map<
  string,
  { capabilityId: string; expiresAt: number }
>();
let capabilityCounter = 0;

function cacheCapabilityId(capabilityId: string): string {
  const key = `c_${capabilityCounter++}`;
  if (capabilityCounter > 999_999) capabilityCounter = 0;
  capabilityCache.set(key, {
    capabilityId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return key;
}

function getCapabilityId(key: string): string | null {
  const entry = capabilityCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    capabilityCache.delete(key);
    return null;
  }
  return entry.capabilityId;
}

/** JWT pending map for /auth flow */
const jwtPendingMap = new Map<
  string,
  { telegramId: string; expiresAt: number }
>();
let jwtCounter = 0;

/**
 * Conversation state — tracks multi-step flows
 * (e.g. user tapped "Withdraw" and we're waiting for amount)
 */
interface ConversationState {
  step: string;
  data: Record<string, any>;
  expiresAt: number;
}

const conversationState = new Map<string, ConversationState>();

function setConversation(
  telegramId: string,
  step: string,
  data: Record<string, any> = {},
) {
  conversationState.set(telegramId, {
    step,
    data,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min TTL
  });
}

function getConversation(telegramId: string): ConversationState | null {
  const state = conversationState.get(telegramId);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    conversationState.delete(telegramId);
    return null;
  }
  return state;
}

function clearConversation(telegramId: string) {
  conversationState.delete(telegramId);
}

// ──────────────────────────────────────────────
//  Register all handlers
// ──────────────────────────────────────────────

export function registerCommands(bot: Telegraf<BotContext>): void {
  // ── Slash commands (still work as fallbacks) ──
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("copy", handleCopyCommand);
  bot.command("positions", handlePositions);
  bot.command("stop", handleStop);
  bot.command("status", handleStatus);
  bot.command("balance", handleBalance);
  bot.command("link", handleLink);
  bot.command("discover", handleDiscoverCommand);
  bot.command("pools", handlePools);
  bot.command("connect", handleConnect);
  bot.command("wallet", handleWallet);
  bot.command("grant", handleGrant);
  bot.command("revoke", handleRevoke);
  bot.command("auth", handleAuth);
  bot.command("deposit", handleDeposit);
  bot.command("withdraw", handleWithdrawCommand);

  // ── Main menu button callbacks ──
  bot.action("menu_main", handleMainMenu);
  bot.action("menu_copy_trading", handleCopyTradingMenu);
  bot.action("menu_pools", handlePoolsMenu);
  bot.action("menu_wallet", handleWalletMenu);
  bot.action("menu_positions", handlePositionsMenu);
  bot.action("menu_settings", handleSettingsMenu);
  bot.action("menu_help", handleHelpMenu);

  // ── Wallet submenu ──
  bot.action("wallet_connect", handleConnectAction);
  bot.action("wallet_deposit", handleDepositAction);
  bot.action("wallet_withdraw", handleWithdrawAction);
  bot.action("wallet_balance", handleBalanceAction);

  // ── Pool browsing ──
  bot.action(/^pool_discover_(.+)$/, handlePoolDiscoverAction);

  // ── Maker copy flow ──
  bot.action(/^copy_maker_(.+)$/, handleCopyMakerCallback);
  bot.action(/^copy_ratio_(\d+)_(.+)$/, handleCopyRatioCallback);
  bot.action("copy_ratio_custom", handleCopyRatioCustom);

  // ── Position management ──
  bot.action(/^stop_(.+)$/, handleStopConfirm);
  bot.action("cancel_stop", handleCancelStop);
  bot.action(/^pos_grant_(.+)$/, handleGrantAction);
  bot.action(/^pos_revoke_(.+)$/, handleRevokeAction);

  // ── Auth flow ──
  bot.action(/^auth_jwt_(.+)$/, handleAuthJwtCallback);

  // ── Status ──
  bot.action("menu_status", handleStatusAction);

  // ── Back navigation ──
  bot.action("back_main", handleMainMenu);

  // ── Free-text input handler (for multi-step flows) ──
  bot.on("text", handleTextInput);
}

// ══════════════════════════════════════════════
//  MAIN MENU
// ══════════════════════════════════════════════

function buildMainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🪞 Copy Trading", "menu_copy_trading"),
      Markup.button.callback("📊 Pools", "menu_pools"),
    ],
    [
      Markup.button.callback("💰 Wallet", "menu_wallet"),
      Markup.button.callback("📋 Positions", "menu_positions"),
    ],
    [
      Markup.button.callback("📈 Status", "menu_status"),
      Markup.button.callback("⚙️ Settings", "menu_settings"),
    ],
    [Markup.button.callback("❓ Help", "menu_help")],
  ]);
}

async function handleStart(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const username = ctx.from?.first_name || "there";
  const user = userRepo.getByTelegramId(telegramId);

  const hasWallet = !!user?.zklogin_address;

  let walletLine = "";
  if (hasWallet) {
    let balance = "...";
    try {
      const rawBalance = await suiService.getBalance(user!.zklogin_address!);
      balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
    } catch {
      balance = "N/A";
    }
    walletLine =
      `\n💳 Wallet: ${truncateAddress(user!.zklogin_address!)}\n` +
      `💰 Balance: ${balance}\n`;
  } else {
    walletLine =
      "\n⚠️ No wallet connected — tap Wallet → Connect to get started.\n";
  }

  await ctx.reply(
    `🪞 Welcome to Miru, ${username}!\n` +
      walletLine +
      `\nMiru automatically copies top LPs on Sui's DeepBook CLOB — fully non-custodial.\n\n` +
      `Select an option:`,
    buildMainMenuKeyboard(),
  );
}

async function handleMainMenu(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  let walletLine = "";
  if (user?.zklogin_address) {
    let balance = "...";
    try {
      const rawBalance = await suiService.getBalance(user.zklogin_address);
      balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
    } catch {
      balance = "N/A";
    }
    walletLine =
      `💳 ${truncateAddress(user.zklogin_address)}\n` + `💰 ${balance}\n\n`;
  }

  try {
    await ctx.editMessageText(
      `🪞 Miru — Main Menu\n\n` + walletLine + `Select an option:`,
      buildMainMenuKeyboard(),
    );
  } catch {
    await ctx.reply(
      `🪞 Miru — Main Menu\n\n` + walletLine + `Select an option:`,
      buildMainMenuKeyboard(),
    );
  }
  await ctx.answerCbQuery?.().catch(() => {});
}

// ══════════════════════════════════════════════
//  COPY TRADING MENU
// ══════════════════════════════════════════════

async function handleCopyTradingMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    try {
      await ctx.editMessageText(
        `🪞 Copy Trading\n\n` +
          `⚠️ You need to connect a wallet first.\n\n` +
          `Tap "Connect Wallet" to sign in with Google.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔐 Connect Wallet", "wallet_connect")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    } catch {
      await ctx.reply(
        `🪞 Copy Trading\n\n⚠️ Connect a wallet first.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔐 Connect Wallet", "wallet_connect")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    }
    return;
  }

  const positions = positionRepo.getActiveByUser(telegramId);

  try {
    await ctx.editMessageText(
      `🪞 Copy Trading\n\n` +
        `Active mirrors: ${positions.length}\n\n` +
        `Browse pools and discover top makers to copy their limit orders automatically.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔍 Browse Pools", "menu_pools")],
        [Markup.button.callback("📋 My Positions", "menu_positions")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
  } catch {
    await ctx.reply(
      `🪞 Copy Trading\n\nActive mirrors: ${positions.length}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔍 Browse Pools", "menu_pools")],
        [Markup.button.callback("📋 My Positions", "menu_positions")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
  }
}

// ══════════════════════════════════════════════
//  POOLS MENU
// ══════════════════════════════════════════════

async function handlePoolsMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  try {
    await ctx.editMessageText("🔍 Fetching available pools...");
  } catch {
    await ctx.reply("🔍 Fetching available pools...");
  }

  try {
    const [pools, summaries] = await Promise.all([
      getPools(),
      getPoolSummaries().catch(() => [] as PoolSummary[]),
    ]);

    if (!pools || pools.length === 0) {
      await ctx.reply(
        "📊 No pools found.\n\n💡 Try again in a moment.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Retry", "menu_pools")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
      return;
    }

    const summaryMap = new Map<string, PoolSummary>();
    for (const s of summaries) {
      summaryMap.set(s.trading_pairs, s);
    }

    let msg = `📊 DeepBook Pools (${pools.length})\n\n`;

    const displayPools = pools.slice(0, 10);
    for (const pool of displayPools) {
      const s = summaryMap.get(pool.pool_name);
      msg += `• ${pool.pool_name}`;
      if (s && s.last_price > 0) {
        const price = formatPrice(s.last_price);
        const change = s.price_change_percent_24h;
        const changeStr =
          change >= 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}%`;
        msg += ` — ${price} (${changeStr})`;
      }
      msg += `\n`;
    }

    if (pools.length > 10) {
      msg += `\n...and ${pools.length - 10} more\n`;
    }

    msg += `\nTap a pool to discover top makers:`;

    const buttons = displayPools.map((pool) => [
      Markup.button.callback(
        `🔍 ${pool.pool_name}`,
        `pool_discover_${pool.pool_name}`,
      ),
    ]);
    buttons.push([Markup.button.callback("◀️ Back", "back_main")]);

    await ctx.reply(msg, Markup.inlineKeyboard(buttons));
  } catch (error) {
    console.error("Error fetching pools:", error);
    const parsed = parseSuiError(error);
    if (
      parsed.category === ErrorCategory.NETWORK_ERROR ||
      parsed.category === ErrorCategory.TIMEOUT
    ) {
      await ctx.reply(
        "❌ Could not reach the DeepBook indexer.\n\n💡 Try again in a few seconds.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Retry", "menu_pools")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    } else {
      await ctx.reply(formatErrorForUser(parsed));
    }
  }
}

// ══════════════════════════════════════════════
//  POOL DISCOVER (from pool buttons)
// ══════════════════════════════════════════════

async function handlePoolDiscoverAction(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});
  const match = (ctx as any).match;
  if (!match || !match[1]) return;

  const poolName = match[1] as string;
  await ctx.reply(`🔍 Scanning ${poolName} for top makers...`);

  try {
    const overview = await getPoolOverview(poolName);

    let msg = `🔍 ${poolName} — Maker Discovery\n\n`;

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
        `📊 24h Vol: ${vol}\n` +
        `📐 Spread: ${spread}%\n` +
        `📚 Book: ${overview.orderBookDepth.bids} bids / ${overview.orderBookDepth.asks} asks\n\n`;
    }

    if (overview.topMakers.length === 0) {
      msg += `⚠️ No active makers found in the last 24h.\n`;
      await ctx.reply(
        msg,
        Markup.inlineKeyboard([
          [Markup.button.callback("📊 Other Pools", "menu_pools")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
      return;
    }

    msg += `🏆 Top Makers\n\n`;

    for (let i = 0; i < overview.topMakers.length; i++) {
      const m = overview.topMakers[i];
      const medal =
        i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
      msg +=
        `${medal} ${truncateAddress(m.balanceManagerId)}\n` +
        `   Orders: ${m.orderCount} (${m.buyOrders}B/${m.sellOrders}S) | Vol: ${formatNumber(m.totalVolume)}\n` +
        `   Fill: ${m.fillRate.toFixed(1)}% | Range: ${formatPrice(m.priceRange.low)}–${formatPrice(m.priceRange.high)}\n\n`;
    }

    await ctx.reply(msg);

    // Maker copy buttons
    const buttons = overview.topMakers.map((m, i) => {
      const medal =
        i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
      const cacheKey = cacheDiscoverEntry(poolName, m.balanceManagerId);
      return [
        Markup.button.callback(
          `${medal} Copy ${truncateAddress(m.balanceManagerId)}`,
          `copy_maker_${cacheKey}`,
        ),
      ];
    });
    buttons.push([Markup.button.callback("📊 Other Pools", "menu_pools")]);
    buttons.push([Markup.button.callback("◀️ Back", "back_main")]);

    await ctx.reply(
      `⬇️ Tap a maker to start copying:`,
      Markup.inlineKeyboard(buttons),
    );
  } catch (error) {
    console.error("Error discovering makers:", error);
    const parsed = parseSuiError(error);
    if (
      parsed.category === ErrorCategory.NETWORK_ERROR ||
      parsed.category === ErrorCategory.TIMEOUT
    ) {
      await ctx.reply(
        `❌ Could not reach the indexer for ${poolName}.\n\n💡 Try again shortly.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Retry", `pool_discover_${poolName}`)],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    } else {
      await ctx.reply(
        `❌ Failed to discover makers on ${poolName}.\n\n${formatErrorForUser(parsed)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📊 Other Pools", "menu_pools")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    }
  }
}

// ══════════════════════════════════════════════
//  COPY MAKER FLOW (button-driven)
// ══════════════════════════════════════════════

async function handleCopyMakerCallback(ctx: BotContext): Promise<void> {
  const match = (ctx as any).match;
  if (!match || !match[1]) return;

  const cacheKey = match[1] as string;
  const entry = getDiscoverEntry(cacheKey);

  if (!entry) {
    await ctx.answerCbQuery("⏰ Selection expired. Browse pools again.");
    return;
  }

  await ctx.answerCbQuery("Loading...");

  const { poolName, balanceManagerId } = entry;
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply(
      `⚠️ Connect a wallet first to start copying.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect Wallet", "wallet_connect")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
    return;
  }

  // Check already copying
  const existingPositions = positionRepo.getActiveByUser(telegramId);
  const duplicate = existingPositions.find(
    (p) =>
      p.target_maker === balanceManagerId &&
      p.pool_key === poolName.toUpperCase(),
  );

  if (duplicate) {
    await ctx.reply(
      `⚠️ You're already copying this maker on ${poolName}.\n\nStop the existing position first.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📋 My Positions", "menu_positions")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
    return;
  }

  // Show ratio selection
  await ctx.reply(
    `🪞 Copy Maker\n\n` +
      `Pool: ${poolName}\n` +
      `Maker: ${truncateAddress(balanceManagerId)}\n\n` +
      `Select copy ratio (% of maker's order size):`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("10%", `copy_ratio_10_${cacheKey}`),
        Markup.button.callback("25%", `copy_ratio_25_${cacheKey}`),
        Markup.button.callback("50%", `copy_ratio_50_${cacheKey}`),
      ],
      [
        Markup.button.callback("75%", `copy_ratio_75_${cacheKey}`),
        Markup.button.callback("100%", `copy_ratio_100_${cacheKey}`),
      ],
      [Markup.button.callback("✏️ Custom Ratio", "copy_ratio_custom")],
      [Markup.button.callback("◀️ Cancel", "back_main")],
    ]),
  );

  // Store context for custom ratio
  setConversation(telegramId, "awaiting_custom_ratio", {
    poolName,
    balanceManagerId,
    cacheKey,
  });
}

async function handleCopyRatioCallback(ctx: BotContext): Promise<void> {
  const match = (ctx as any).match;
  if (!match || !match[1] || !match[2]) return;

  const ratio = parseInt(match[1]);
  const cacheKey = match[2] as string;
  const entry = getDiscoverEntry(cacheKey);

  if (!entry) {
    await ctx.answerCbQuery("⏰ Selection expired.");
    return;
  }

  await ctx.answerCbQuery(`Copying at ${ratio}%...`);
  const telegramId = ctx.from!.id.toString();
  clearConversation(telegramId);

  await executeCopy(
    ctx,
    telegramId,
    entry.balanceManagerId,
    entry.poolName,
    ratio,
  );
}

async function handleCopyRatioCustom(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const telegramId = ctx.from!.id.toString();
  const conv = getConversation(telegramId);

  if (!conv || conv.step !== "awaiting_custom_ratio") {
    await ctx.reply(
      "⏰ Session expired. Please start again from Pools.",
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Pools", "menu_pools")],
      ]),
    );
    return;
  }

  setConversation(telegramId, "entering_custom_ratio", conv.data);

  await ctx.reply(
    `✏️ Enter your custom ratio (1-100):\n\n` +
      `Type a number, e.g. "35" for 35% of maker's order size.`,
  );
}

/** Execute copy position (shared by button flow and /copy command) */
async function executeCopy(
  ctx: BotContext,
  telegramId: string,
  makerAddress: string,
  poolKey: string,
  ratio: number,
): Promise<void> {
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.sui_address) {
    await ctx.reply(
      "⚠️ No wallet connected.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect Wallet", "wallet_connect")],
      ]),
    );
    return;
  }

  await ctx.reply(
    `🔄 Setting up mirror position...\n\n` +
      `Maker: ${truncateAddress(makerAddress)}\n` +
      `Pool: ${poolKey.toUpperCase()}\n` +
      `Ratio: ${ratio}%\n\n` +
      `⏳ Creating on-chain position...`,
  );

  try {
    const hasZkLogin =
      user.zklogin_address && (await zkLoginService.isSessionValid(telegramId));

    if (hasZkLogin) {
      // Pre-check gas
      try {
        const rawBalance = await suiService.getBalance(user.zklogin_address!);
        const gasCheck = checkGasBalance(rawBalance, "Your zkLogin wallet");
        if (gasCheck) {
          await ctx.reply(
            gasCheck,
            Markup.inlineKeyboard([
              [Markup.button.callback("💳 Deposit", "wallet_deposit")],
              [Markup.button.callback("◀️ Back", "back_main")],
            ]),
          );
          return;
        }
      } catch (balanceErr) {
        console.warn("Could not pre-check balance:", balanceErr);
      }

      const poolId = await deepBookService.getPoolId(poolKey.toUpperCase());
      const operatorAddress = txBuilderService.getOperatorAddress();
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

      const result = await zkLoginService.signAndExecuteFull(
        telegramId,
        txBuilderService.buildCreatePositionAndGrant(
          user.zklogin_address!,
          makerAddress,
          ratio,
          poolId,
          operatorAddress,
          0,
          expiresAt,
        ),
      );

      const { positionId, capabilityId } = extractCreatedObjects(
        result.objectChanges,
      );

      if (!positionId) {
        throw new Error(
          "Position not found in transaction result. Tx: " + result.digest,
        );
      }

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

      const { eventMonitor } = await import("../services/event-monitor.js");
      eventMonitor.subscribeToPool(poolKey.toUpperCase(), poolId, [
        makerAddress,
      ]);

      await ctx.reply(
        `✅ Mirror position created!\n\n` +
          `📋 Position: ${truncateAddress(positionId)}\n` +
          `🎯 Maker: ${truncateAddress(makerAddress)}\n` +
          `📊 Pool: ${poolKey.toUpperCase()}\n` +
          `⚖️ Ratio: ${ratio}%\n` +
          `🔗 Tx: ${truncateAddress(result.digest)}\n` +
          (capabilityId
            ? `🔑 Capability: ${truncateAddress(capabilityId)}\n`
            : "") +
          `\nYou own this position. The bot mirrors orders via a granted capability.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📋 My Positions", "menu_positions")],
          [Markup.button.callback("◀️ Main Menu", "back_main")],
        ]),
      );
    } else {
      // Legacy custodial flow
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
          `🔗 Tx: ${truncateAddress(txDigest)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📋 My Positions", "menu_positions")],
          [Markup.button.callback("◀️ Main Menu", "back_main")],
        ]),
      );
    }
  } catch (error) {
    console.error("Error creating position:", error);
    const parsed = parseZkLoginError(error);
    let reply = formatErrorForUser(parsed);

    if (parsed.category === ErrorCategory.INSUFFICIENT_GAS) {
      reply +=
        "\n\n📋 Your wallet address:\n" +
        (user.zklogin_address || "(use Wallet to see)");
    } else if (parsed.category === ErrorCategory.SESSION_EXPIRED) {
      reply += "\n\n🔄 Reconnect via Wallet → Connect.";
    }

    await ctx.reply(
      reply,
      Markup.inlineKeyboard([
        [Markup.button.callback("💰 Wallet", "menu_wallet")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  }
}

// ══════════════════════════════════════════════
//  WALLET MENU
// ══════════════════════════════════════════════

async function handleWalletMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    try {
      await ctx.editMessageText(
        `💰 Wallet\n\n` +
          `No wallet connected yet.\n\n` +
          `Sign in with Google to create your non-custodial zkLogin wallet.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔐 Connect with Google", "wallet_connect")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    } catch {
      await ctx.reply(
        `💰 Wallet\n\nNo wallet connected.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔐 Connect with Google", "wallet_connect")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    }
    return;
  }

  let balance = "Loading...";
  let sessionStatus = "checking...";
  try {
    const rawBalance = await suiService.getBalance(user.zklogin_address);
    balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
  } catch {
    balance = "Unable to fetch";
  }

  try {
    const valid = await zkLoginService.isSessionValid(telegramId);
    sessionStatus = valid ? "✅ Active" : "❌ Expired";
  } catch {
    sessionStatus = "⚠️ Unknown";
  }

  const msg =
    `💰 Wallet\n\n` +
    `Address:\n${user.zklogin_address}\n\n` +
    `Balance: ${balance}\n` +
    `Session: ${sessionStatus}\n` +
    `Auth: Google (zkLogin)\n\n` +
    `This is a non-custodial wallet — only you can sign transactions.`;

  const buttons = [
    [
      Markup.button.callback("💳 Deposit", "wallet_deposit"),
      Markup.button.callback("📤 Withdraw", "wallet_withdraw"),
    ],
    [
      Markup.button.callback("🔄 Refresh", "menu_wallet"),
      Markup.button.callback("🔐 Reconnect", "wallet_connect"),
    ],
    [Markup.button.callback("◀️ Back", "back_main")],
  ];

  try {
    await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons));
  } catch {
    await ctx.reply(msg, Markup.inlineKeyboard(buttons));
  }
}

// ── Wallet sub-actions ──

async function handleConnectAction(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});
  await handleConnectFlow(ctx);
}

async function handleDepositAction(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ Connect a wallet first.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  let balance = "N/A";
  try {
    const rawBalance = await suiService.getBalance(user.zklogin_address);
    balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
  } catch {
    /* ignore */
  }

  await ctx.reply(
    `💳 Deposit to your Miru wallet\n\n` +
      `Your address:\n${user.zklogin_address}\n\n` +
      `Current balance: ${balance}\n\n` +
      `Send SUI to the address above from any Sui wallet.\n\n` +
      `💡 You need SUI for:\n` +
      `• Gas fees when creating positions\n` +
      `• Gas fees when granting/revoking capabilities`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💰 Wallet", "menu_wallet")],
      [Markup.button.callback("◀️ Main Menu", "back_main")],
    ]),
  );
}

async function handleWithdrawAction(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ Connect a wallet first.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  let balance = "N/A";
  try {
    const rawBalance = await suiService.getBalance(user.zklogin_address);
    balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
  } catch {
    /* ignore */
  }

  setConversation(telegramId, "withdraw_amount", {});

  await ctx.reply(
    `📤 Withdraw SUI\n\n` +
      `Current balance: ${balance}\n\n` +
      `Enter the amount and recipient address:\n` +
      `Format: <amount> <address>\n\n` +
      `Example: 1.5 0x6db1...c9da`,
  );
}

async function handleBalanceAction(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});
  await handleBalance(ctx);
}

// ══════════════════════════════════════════════
//  POSITIONS MENU
// ══════════════════════════════════════════════

async function handlePositionsMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const telegramId = ctx.from!.id.toString();
  const positions = positionRepo.getAllByUser(telegramId);

  if (positions.length === 0) {
    try {
      await ctx.editMessageText(
        `📋 Positions\n\nYou have no positions yet.\n\nBrowse pools to find makers and start copying!`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔍 Browse Pools", "menu_pools")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    } catch {
      await ctx.reply(
        `📋 No positions yet.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔍 Browse Pools", "menu_pools")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    }
    return;
  }

  let msg = `📋 Your Positions (${positions.length})\n\n`;

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  for (const pos of positions) {
    const status = pos.is_active ? "🟢" : "🔴";
    msg +=
      `${status} ${pos.pool_key} — ${truncateAddress(pos.target_maker)} — ${pos.ratio}%\n` +
      `   Orders: ${pos.total_orders_placed} | ID: ${truncateAddress(pos.id)}\n\n`;

    if (pos.is_active) {
      const cacheKey = cachePositionId(pos.id);
      buttons.push([
        Markup.button.callback(
          `⏹ Stop ${pos.pool_key} (${truncateAddress(pos.target_maker)})`,
          `stop_${cacheKey}`,
        ),
      ]);
    }
  }

  buttons.push([Markup.button.callback("🔍 Browse Pools", "menu_pools")]);
  buttons.push([Markup.button.callback("◀️ Back", "back_main")]);

  try {
    await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons));
  } catch {
    await ctx.reply(msg, Markup.inlineKeyboard(buttons));
  }
}

// ══════════════════════════════════════════════
//  SETTINGS MENU
// ══════════════════════════════════════════════

async function handleSettingsMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  let msg = `⚙️ Settings\n\n`;

  if (user?.sui_address) {
    msg += `Linked wallet: ${truncateAddress(user.sui_address)}\n`;
  }
  if (user?.zklogin_address) {
    msg += `zkLogin wallet: ${truncateAddress(user.zklogin_address)}\n`;
  }

  msg += `Network: ${suiService.getNetwork()}\n\n`;
  msg += `To link an external wallet, use:\n/link <your_address>`;

  try {
    await ctx.editMessageText(
      msg,
      Markup.inlineKeyboard([
        [Markup.button.callback("💰 Wallet", "menu_wallet")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
  } catch {
    await ctx.reply(
      msg,
      Markup.inlineKeyboard([
        [Markup.button.callback("💰 Wallet", "menu_wallet")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
  }
}

// ══════════════════════════════════════════════
//  HELP MENU
// ══════════════════════════════════════════════

async function handleHelpMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const msg =
    `❓ How to use Miru\n\n` +
    `1️⃣ Connect — Sign in with Google to create your non-custodial wallet\n\n` +
    `2️⃣ Fund — Deposit SUI to your wallet for gas fees\n\n` +
    `3️⃣ Browse — Explore DeepBook pools and discover top makers\n\n` +
    `4️⃣ Copy — Select a maker and choose your copy ratio\n\n` +
    `5️⃣ Earn — The bot automatically mirrors the maker's limit orders\n\n` +
    `6️⃣ Manage — View positions, stop copying, or withdraw anytime\n\n` +
    `💡 Tips:\n` +
    `• Start with a small ratio (10-25%) to test\n` +
    `• You control your funds — revoke bot access anytime\n` +
    `• Use the Wallet menu to deposit/withdraw\n\n` +
    `All commands also work as /slash commands if you prefer.`;

  try {
    await ctx.editMessageText(
      msg,
      Markup.inlineKeyboard([[Markup.button.callback("◀️ Back", "back_main")]]),
    );
  } catch {
    await ctx.reply(
      msg,
      Markup.inlineKeyboard([[Markup.button.callback("◀️ Back", "back_main")]]),
    );
  }
}

// ══════════════════════════════════════════════
//  STATUS ACTION
// ══════════════════════════════════════════════

async function handleStatusAction(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});

  const engineStatus = mirrorEngine.getStatus();

  const msg =
    `📈 Miru Status\n\n` +
    `Engine: ${engineStatus.isRunning ? "🟢 Running" : "🔴 Stopped"}\n` +
    `Tracked Makers: ${engineStatus.trackedMakers}\n` +
    `Active Positions: ${engineStatus.totalPositions}\n` +
    `Network: ${suiService.getNetwork()}`;

  try {
    await ctx.editMessageText(
      msg,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Refresh", "menu_status")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
  } catch {
    await ctx.reply(
      msg,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Refresh", "menu_status")],
        [Markup.button.callback("◀️ Back", "back_main")],
      ]),
    );
  }
}

// ══════════════════════════════════════════════
//  CONNECT FLOW (shared by button and /connect)
// ══════════════════════════════════════════════

async function handleConnectFlow(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();

  try {
    const user = userRepo.getByTelegramId(telegramId);
    if (user?.zklogin_address) {
      const valid = await zkLoginService.isSessionValid(telegramId);
      if (valid) {
        await ctx.reply(
          `🔐 Already connected!\n\n` +
            `Address: ${truncateAddress(user.zklogin_address)}\n\n` +
            `Reconnecting to refresh session...`,
        );
      }
    }

    await ctx.reply("🔄 Initializing zkLogin session...");

    const { nonce, oauthUrl } = await zkLoginService.initSession(telegramId);

    const jwtKey = `j_${jwtCounter++}`;
    if (jwtCounter > 999_999) jwtCounter = 0;
    jwtPendingMap.set(jwtKey, {
      telegramId,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    await ctx.reply(
      `🔐 Sign in with Google\n\nTap the button below to authenticate:`,
      Markup.inlineKeyboard([
        [Markup.button.url("🔑 Sign in with Google", oauthUrl)],
      ]),
    );

    await ctx.reply(
      `After signing in, you'll see a page with your JWT token.\n\n` +
        `Copy the full token and paste it here directly — no need for /auth.\n\n` +
        `⏱ This link expires in 10 minutes.`,
    );

    // Accept JWT as free text
    setConversation(telegramId, "awaiting_jwt", {});
  } catch (error: any) {
    console.error("Connect error:", error);
    const parsed = parseZkLoginError(error);
    if (
      parsed.category === ErrorCategory.NETWORK_ERROR ||
      parsed.category === ErrorCategory.TIMEOUT
    ) {
      await ctx.reply(
        "❌ Could not connect to the Sui network.\n\n💡 Try again in a few seconds.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Retry", "wallet_connect")],
          [Markup.button.callback("◀️ Back", "back_main")],
        ]),
      );
    } else {
      await ctx.reply(formatErrorForUser(parsed));
    }
  }
}

// ══════════════════════════════════════════════
//  FREE-TEXT INPUT HANDLER
// ══════════════════════════════════════════════

async function handleTextInput(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const text = ((ctx.message as any)?.text || "").trim();

  // Ignore slash commands
  if (text.startsWith("/")) return;

  const conv = getConversation(telegramId);
  if (!conv) return; // No active conversation, ignore

  switch (conv.step) {
    case "awaiting_jwt":
      await processJwtInput(ctx, telegramId, text);
      break;

    case "entering_custom_ratio":
      await processCustomRatioInput(ctx, telegramId, text, conv.data);
      break;

    case "withdraw_amount":
      await processWithdrawInput(ctx, telegramId, text);
      break;

    default:
      clearConversation(telegramId);
      break;
  }
}

async function processJwtInput(
  ctx: BotContext,
  telegramId: string,
  jwt: string,
): Promise<void> {
  clearConversation(telegramId);

  // JWT has 3 parts
  if (!jwt.includes(".") || jwt.split(".").length !== 3) {
    await ctx.reply(
      `❌ That doesn't look like a valid JWT token.\n\n` +
        `A JWT has 3 parts separated by dots.\n` +
        `Make sure you copied the complete token.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Try Again", "wallet_connect")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
    return;
  }

  try {
    await ctx.reply("🔄 Processing authentication...");

    const { address } = await zkLoginService.processJwtCallback(
      telegramId,
      jwt,
    );

    await ctx.reply(
      `✅ Wallet connected!\n\n` +
        `Your Sui address:\n${address}\n\n` +
        `This address is derived from your Google identity via zkLogin.\n` +
        `No one — not even the bot — can access your funds without your approval.\n\n` +
        `Next steps:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Browse Pools", "menu_pools")],
        [Markup.button.callback("💳 Deposit SUI", "wallet_deposit")],
        [Markup.button.callback("💰 View Wallet", "menu_wallet")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  } catch (error: any) {
    console.error("Auth error:", error);
    const parsed = parseZkLoginError(error);

    let reply = formatErrorForUser(parsed);
    if (parsed.category === ErrorCategory.INVALID_INPUT) {
      reply +=
        "\n\n📝 Make sure you:\n" +
        "1. Copied the FULL token\n" +
        "2. Didn't add extra spaces\n" +
        "3. The token hasn't expired";
    } else if (parsed.category === ErrorCategory.PROVER_ERROR) {
      reply += "\n\n🔄 Try connecting again.";
    } else if (parsed.category === ErrorCategory.SESSION_MISSING) {
      reply += "\n\n🔄 Start with Connect first.";
    }

    await ctx.reply(
      reply,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Reconnect", "wallet_connect")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  }
}

async function processCustomRatioInput(
  ctx: BotContext,
  telegramId: string,
  text: string,
  data: Record<string, any>,
): Promise<void> {
  clearConversation(telegramId);

  const ratio = parseInt(text, 10);
  if (isNaN(ratio) || ratio < 1 || ratio > 100) {
    await ctx.reply(
      `❌ Invalid ratio. Enter a number between 1 and 100.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Browse Pools", "menu_pools")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
    return;
  }

  const entry = getDiscoverEntry(data.cacheKey);
  if (!entry) {
    await ctx.reply(
      "⏰ Selection expired. Please browse pools again.",
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Browse Pools", "menu_pools")],
      ]),
    );
    return;
  }

  await executeCopy(
    ctx,
    telegramId,
    entry.balanceManagerId,
    entry.poolName,
    ratio,
  );
}

async function processWithdrawInput(
  ctx: BotContext,
  telegramId: string,
  text: string,
): Promise<void> {
  clearConversation(telegramId);

  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply(
      `❌ Please enter amount and address.\n\nFormat: <amount> <address>\nExample: 1.5 0xABC...DEF`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📤 Try Again", "wallet_withdraw")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
    return;
  }

  const amount = parseFloat(parts[0]);
  const recipient = parts[1];

  if (isNaN(amount) || amount <= 0) {
    await ctx.reply("❌ Invalid amount. Must be a positive number.");
    return;
  }

  const addrErr = validateSuiAddress(recipient);
  if (addrErr) {
    await ctx.reply(`❌ ${addrErr}`);
    return;
  }

  const user = userRepo.getByTelegramId(telegramId);
  if (!user?.zklogin_address) {
    await ctx.reply("⚠️ No wallet connected.");
    return;
  }

  try {
    const valid = await zkLoginService.isSessionValid(telegramId);
    if (!valid) {
      await ctx.reply(
        "❌ Session expired. Please reconnect.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔐 Reconnect", "wallet_connect")],
        ]),
      );
      return;
    }

    await ctx.reply(
      `⏳ Sending ${amount} SUI to ${truncateAddress(recipient)}...`,
    );

    const amountMist = Math.floor(amount * 1_000_000_000);
    const digest = await zkLoginService.signAndExecute(telegramId, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [amountMist]);
      tx.transferObjects([coin], recipient);
    });

    await ctx.reply(
      `✅ Withdrawal complete!\n\n` +
        `Amount: ${amount} SUI\n` +
        `To: ${truncateAddress(recipient)}\n` +
        `Tx: ${truncateAddress(digest)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💰 Wallet", "menu_wallet")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  } catch (error: any) {
    console.error("Withdraw error:", error);
    await ctx.reply(
      `❌ Withdrawal failed: ${extractErrorMessage(error)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💰 Wallet", "menu_wallet")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  }
}

// ══════════════════════════════════════════════
//  SLASH COMMAND HANDLERS (fallbacks)
// ══════════════════════════════════════════════

async function handleHelp(ctx: BotContext): Promise<void> {
  await handleHelpMenu(ctx);
}

async function handleConnect(ctx: BotContext): Promise<void> {
  await handleConnectFlow(ctx);
}

async function handleAuth(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);

  if (args.length < 1) {
    await ctx.reply(
      "Paste the JWT token from the Google sign-in redirect.\n\n" +
        "If you haven't signed in yet:",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  await processJwtInput(ctx, telegramId, args[0]);
}

async function handleAuthJwtCallback(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery?.().catch(() => {});
}

async function handleWallet(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.zklogin_address) {
    await ctx.reply(
      `💰 Wallet\n\nNo wallet connected.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect with Google", "wallet_connect")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
    return;
  }

  let balance = "N/A";
  let sessionStatus = "checking...";
  try {
    const rawBalance = await suiService.getBalance(user.zklogin_address);
    balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
  } catch {
    balance = "Unable to fetch";
  }

  try {
    const valid = await zkLoginService.isSessionValid(telegramId);
    sessionStatus = valid ? "✅ Active" : "❌ Expired";
  } catch {
    sessionStatus = "⚠️ Unknown";
  }

  await ctx.reply(
    `💰 Wallet\n\n` +
      `Address:\n${user.zklogin_address}\n\n` +
      `Balance: ${balance}\n` +
      `Session: ${sessionStatus}\n` +
      `Auth: Google (zkLogin)`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("💳 Deposit", "wallet_deposit"),
        Markup.button.callback("📤 Withdraw", "wallet_withdraw"),
      ],
      [
        Markup.button.callback("🔄 Refresh", "menu_wallet"),
        Markup.button.callback("🔐 Reconnect", "wallet_connect"),
      ],
      [Markup.button.callback("◀️ Main Menu", "back_main")],
    ]),
  );
}

async function handlePools(ctx: BotContext): Promise<void> {
  await handlePoolsMenu(ctx);
}

async function handleDiscoverCommand(ctx: BotContext): Promise<void> {
  const args = getArgs(ctx);

  if (args.length === 0) {
    await ctx.reply(
      `🔍 Discover top makers\n\nBrowse pools to find makers:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Browse Pools", "menu_pools")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
    return;
  }

  const poolName = args[0].toUpperCase();
  await ctx.reply(`🔍 Scanning ${poolName} for top makers...`);

  try {
    const overview = await getPoolOverview(poolName);

    let msg = `🔍 ${poolName} — Maker Discovery\n\n`;

    if (overview.summary) {
      const s = overview.summary;
      const price = s.last_price > 0 ? formatPrice(s.last_price) : "N/A";
      const vol = s.base_volume > 0 ? formatNumber(s.base_volume) : "0";
      msg +=
        `📈 Price: ${price} | 📊 24h Vol: ${vol}\n` +
        `📚 Book: ${overview.orderBookDepth.bids} bids / ${overview.orderBookDepth.asks} asks\n\n`;
    }

    if (overview.topMakers.length === 0) {
      msg += `⚠️ No active makers found.\n`;
      await ctx.reply(
        msg,
        Markup.inlineKeyboard([
          [Markup.button.callback("📊 Other Pools", "menu_pools")],
        ]),
      );
      return;
    }

    msg += `🏆 Top Makers\n\n`;
    for (let i = 0; i < overview.topMakers.length; i++) {
      const m = overview.topMakers[i];
      const medal =
        i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
      msg +=
        `${medal} ${truncateAddress(m.balanceManagerId)}\n` +
        `   Orders: ${m.orderCount} | Vol: ${formatNumber(m.totalVolume)} | Fill: ${m.fillRate.toFixed(1)}%\n\n`;
    }

    await ctx.reply(msg);

    const buttons = overview.topMakers.map((m, i) => {
      const medal =
        i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
      const cacheKey = cacheDiscoverEntry(poolName, m.balanceManagerId);
      return [
        Markup.button.callback(
          `${medal} Copy ${truncateAddress(m.balanceManagerId)}`,
          `copy_maker_${cacheKey}`,
        ),
      ];
    });
    buttons.push([Markup.button.callback("◀️ Main Menu", "back_main")]);

    await ctx.reply(`⬇️ Tap a maker to copy:`, Markup.inlineKeyboard(buttons));
  } catch (error) {
    console.error("Discover error:", error);
    await ctx.reply(
      `❌ Failed to discover makers on ${poolName}.\n\nUse /pools to see available pools.`,
    );
  }
}

async function handleCopyCommand(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);
  const args = getArgs(ctx);

  if (!user?.sui_address) {
    await ctx.reply(
      "⚠️ No wallet connected.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  if (args.length < 3) {
    await ctx.reply(
      `📝 Copy a maker\n\n` +
        `Usage: /copy <maker> <pool> <ratio>\n` +
        `Example: /copy 0xABC DEEP_SUI 50\n\n` +
        `Or browse pools to find makers:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📊 Browse Pools", "menu_pools")],
      ]),
    );
    return;
  }

  const [makerAddress, poolKey, ratioStr] = args;

  const addrErr = validateSuiAddress(makerAddress);
  if (addrErr) {
    await ctx.reply(`❌ Invalid maker address: ${addrErr}`);
    return;
  }

  const ratioErr = validateRatio(ratioStr);
  if (ratioErr) {
    await ctx.reply(`❌ ${ratioErr}`);
    return;
  }

  const ratio = parseInt(ratioStr, 10);
  await executeCopy(ctx, telegramId, makerAddress, poolKey, ratio);
}

async function handlePositions(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const positions = positionRepo.getAllByUser(telegramId);

  if (positions.length === 0) {
    await ctx.reply(
      "📋 No positions yet.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔍 Browse Pools", "menu_pools")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
    return;
  }

  let msg = `📋 Your Positions (${positions.length})\n\n`;
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  for (const pos of positions) {
    const status = pos.is_active ? "🟢" : "🔴";
    msg +=
      `${status} ${pos.pool_key} — ${truncateAddress(pos.target_maker)} — ${pos.ratio}%\n` +
      `   Orders: ${pos.total_orders_placed} | ID: ${truncateAddress(pos.id)}\n\n`;

    if (pos.is_active) {
      const cacheKey = cachePositionId(pos.id);
      buttons.push([
        Markup.button.callback(`⏹ Stop ${pos.pool_key}`, `stop_${cacheKey}`),
      ]);
    }
  }

  buttons.push([Markup.button.callback("◀️ Main Menu", "back_main")]);
  await ctx.reply(msg, Markup.inlineKeyboard(buttons));
}

async function handleStop(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);
  const activePositions = positionRepo.getActiveByUser(telegramId);

  if (activePositions.length === 0) {
    await ctx.reply(
      "📋 No active positions to stop.",
      Markup.inlineKeyboard([
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
    return;
  }

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

  const buttons = activePositions.map((pos) => {
    const cacheKey = cachePositionId(pos.id);
    return [
      Markup.button.callback(
        `⏹ ${pos.pool_key} | ${truncateAddress(pos.target_maker)} | ${pos.ratio}%`,
        `stop_${cacheKey}`,
      ),
    ];
  });
  buttons.push([Markup.button.callback("❌ Cancel", "cancel_stop")]);

  await ctx.reply(
    "Which position do you want to stop?",
    Markup.inlineKeyboard(buttons),
  );
}

async function handleStopConfirm(ctx: BotContext): Promise<void> {
  const match = (ctx as any).match;
  if (!match || !match[1]) return;

  const cacheKey = match[1] as string;
  const positionId = getPositionId(cacheKey);

  if (!positionId) {
    await ctx.answerCbQuery("⏰ Selection expired. View positions again.");
    return;
  }

  await ctx.answerCbQuery("Stopping position...");

  try {
    await ctx.editMessageText("⏳ Stopping position...");
  } catch {
    /* ignore */
  }
  await stopPosition(ctx, positionId);
}

async function handleCancelStop(ctx: BotContext): Promise<void> {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText("Cancelled.");
  } catch {
    /* ignore */
  }
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
        `Tx: ${truncateAddress(txDigest)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📋 Positions", "menu_positions")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  } catch (error) {
    console.error("Error stopping position:", error);
    const parsed = parseSuiError(error);
    await ctx.reply(
      `❌ Failed to stop position.\n\n${formatErrorForUser(parsed)}`,
    );
  }
}

async function handleStatus(ctx: BotContext): Promise<void> {
  const engineStatus = mirrorEngine.getStatus();
  await ctx.reply(
    `📈 Miru Status\n\n` +
      `Engine: ${engineStatus.isRunning ? "🟢 Running" : "🔴 Stopped"}\n` +
      `Tracked Makers: ${engineStatus.trackedMakers}\n` +
      `Active Positions: ${engineStatus.totalPositions}\n` +
      `Network: ${suiService.getNetwork()}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("◀️ Main Menu", "back_main")],
    ]),
  );
}

async function handleBalance(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);

  if (!user?.sui_address) {
    await ctx.reply(
      "⚠️ No wallet linked.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  try {
    const suiBalance = await suiService.getBalance(user.sui_address);
    const suiAmount = (parseInt(suiBalance) / 1_000_000_000).toFixed(4);

    let msg = `💰 Balance\n\nSUI: ${suiAmount} SUI\n`;

    if (user.balance_manager_key) {
      try {
        const deepBalance = await deepBookService.getManagerBalance(
          user.balance_manager_key,
          "DEEP",
        );
        msg += `DEEP: ${deepBalance.balance}\n`;
      } catch {
        /* no deposits yet */
      }
    }

    await ctx.reply(
      msg,
      Markup.inlineKeyboard([
        [Markup.button.callback("💰 Wallet", "menu_wallet")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  } catch (error) {
    console.error("Balance error:", error);
    const parsed = parseSuiError(error);
    await ctx.reply(formatErrorForUser(parsed));
  }
}

async function handleLink(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const args = getArgs(ctx);

  if (args.length === 0) {
    const user = userRepo.getByTelegramId(telegramId);
    if (user?.sui_address) {
      await ctx.reply(
        `🔗 Linked wallet: ${user.sui_address}\n\nTo change: /link <new_address>`,
      );
    } else {
      await ctx.reply(`🔗 Link wallet: /link <your_sui_address>`);
    }
    return;
  }

  const suiAddress = args[0];
  const addrErr = validateSuiAddress(suiAddress);
  if (addrErr) {
    await ctx.reply(`❌ ${addrErr}`);
    return;
  }

  userRepo.linkWallet(telegramId, suiAddress);
  await ctx.reply(
    `✅ Wallet linked!\n\nAddress: ${truncateAddress(suiAddress)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("◀️ Main Menu", "back_main")],
    ]),
  );
}

async function handleGrant(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);
  const args = getArgs(ctx);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ No wallet connected.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  if (args.length < 1) {
    await ctx.reply(
      "Usage: /grant <position_id>\n\nGrants the bot permission to mirror orders for your position.",
    );
    return;
  }

  const positionId = args[0];
  const position = positionRepo.getById(positionId);

  if (!position || position.user_telegram_id !== telegramId) {
    await ctx.reply("❌ Position not found or doesn't belong to you.");
    return;
  }

  try {
    await ctx.reply("⏳ Granting operator capability...");

    const operatorAddress = txBuilderService.getOperatorAddress();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

    const result = await zkLoginService.signAndExecuteFull(
      telegramId,
      txBuilderService.buildGrantCapability(
        positionId,
        operatorAddress,
        0,
        expiresAt,
      ),
    );

    const capabilityId = extractCreatedObjects(
      result.objectChanges,
    ).capabilityId;

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

    await ctx.reply(
      `✅ Capability granted!\n\n` +
        `Position: ${truncateAddress(positionId)}\n` +
        (capabilityId ? `Capability: ${truncateAddress(capabilityId)}\n` : "") +
        `Tx: ${truncateAddress(result.digest)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📋 Positions", "menu_positions")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  } catch (error) {
    console.error("Grant error:", error);
    const parsed = parseSuiError(error);
    await ctx.reply(
      `❌ Failed to grant capability.\n\n${formatErrorForUser(parsed)}`,
    );
  }
}

async function handleGrantAction(ctx: BotContext): Promise<void> {
  const match = (ctx as any).match;
  if (!match || !match[1]) return;
  await ctx.answerCbQuery?.().catch(() => {});
  const telegramId = ctx.from!.id.toString();
  const positionId = match[1] as string;

  try {
    await ctx.reply("⏳ Granting operator capability...");
    const user = userRepo.getByTelegramId(telegramId);
    if (!user?.zklogin_address) {
      await ctx.reply("⚠️ No wallet connected.");
      return;
    }

    const operatorAddress = txBuilderService.getOperatorAddress();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

    const result = await zkLoginService.signAndExecuteFull(
      telegramId,
      txBuilderService.buildGrantCapability(
        positionId,
        operatorAddress,
        0,
        expiresAt,
      ),
    );

    const capabilityId = extractCreatedObjects(
      result.objectChanges,
    ).capabilityId;
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

    await ctx.reply(
      `✅ Capability granted!\n\nTx: ${truncateAddress(result.digest)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📋 Positions", "menu_positions")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  } catch (error) {
    console.error("Grant action error:", error);
    const parsed = parseSuiError(error);
    await ctx.reply(`❌ ${formatErrorForUser(parsed)}`);
  }
}

async function handleRevoke(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);
  const args = getArgs(ctx);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ No wallet connected.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  if (args.length < 1) {
    const caps = capabilityRepo.getByUser(telegramId);
    if (caps.length === 0) {
      await ctx.reply(
        "No active capabilities to revoke.",
        Markup.inlineKeyboard([
          [Markup.button.callback("◀️ Main Menu", "back_main")],
        ]),
      );
      return;
    }

    const buttons = caps.map((cap: any) => {
      const cacheKey = cacheCapabilityId(cap.id);
      return [
        Markup.button.callback(
          `🔑 ${truncateAddress(cap.id)} (pos: ${truncateAddress(cap.position_id)})`,
          `pos_revoke_${cacheKey}`,
        ),
      ];
    });
    buttons.push([Markup.button.callback("◀️ Back", "back_main")]);

    await ctx.reply(
      "Select a capability to revoke:",
      Markup.inlineKeyboard(buttons),
    );
    return;
  }

  await revokeCapability(ctx, telegramId, args[0]);
}

async function handleRevokeAction(ctx: BotContext): Promise<void> {
  const match = (ctx as any).match;
  if (!match || !match[1]) return;
  await ctx.answerCbQuery?.().catch(() => {});

  const cacheKey = match[1] as string;
  const capId = getCapabilityId(cacheKey);

  if (!capId) {
    await ctx.reply("⏰ Selection expired. Please try /revoke again.");
    return;
  }

  const telegramId = ctx.from!.id.toString();
  await revokeCapability(ctx, telegramId, capId);
}

async function revokeCapability(
  ctx: BotContext,
  telegramId: string,
  capId: string,
): Promise<void> {
  try {
    await ctx.reply("⏳ Revoking capability...");

    const cap = capabilityRepo.getByPosition(capId) || { position_id: capId };
    const positionId = (cap as any).position_id || capId;
    const result = await zkLoginService.signAndExecuteFull(
      telegramId,
      txBuilderService.buildRevokeCapability(capId, positionId),
    );

    capabilityRepo.deactivate(capId);

    await ctx.reply(
      `✅ Capability revoked!\n\nTx: ${truncateAddress(result.digest)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📋 Positions", "menu_positions")],
        [Markup.button.callback("◀️ Main Menu", "back_main")],
      ]),
    );
  } catch (error) {
    console.error("Revoke error:", error);
    const parsed = parseSuiError(error);
    await ctx.reply(`❌ ${formatErrorForUser(parsed)}`);
  }
}

async function handleDeposit(ctx: BotContext): Promise<void> {
  await handleDepositAction(ctx);
}

async function handleWithdrawCommand(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from!.id.toString();
  const user = userRepo.getByTelegramId(telegramId);
  const args = getArgs(ctx);

  if (!user?.zklogin_address) {
    await ctx.reply(
      "⚠️ No wallet connected.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔐 Connect", "wallet_connect")],
      ]),
    );
    return;
  }

  if (args.length < 2) {
    let balance = "N/A";
    try {
      const rawBalance = await suiService.getBalance(user.zklogin_address);
      balance = (parseInt(rawBalance) / 1_000_000_000).toFixed(4) + " SUI";
    } catch {
      /* ignore */
    }

    await ctx.reply(
      `📤 Withdraw SUI\n\n` +
        `Balance: ${balance}\n\n` +
        `Usage: /withdraw <amount> <address>\n` +
        `Example: /withdraw 1.5 0xABC...DEF`,
    );
    return;
  }

  await processWithdrawInput(ctx, telegramId, args.join(" "));
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════

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

function getArgs(ctx: BotContext): string[] {
  const text = (ctx.message as any)?.text || "";
  return text.split(/\s+/).slice(1);
}

function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_\[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}

function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toFixed(2);
}

function formatPrice(price: number): string {
  if (price === 0) return "0";
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}
