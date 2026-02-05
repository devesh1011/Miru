/**
 * DeepMirror Backend
 *
 * Telegram-based automated liquidity provision bot for Sui's DeepBook CLOB.
 *
 * Boot sequence:
 *   1. Load config & .env
 *   2. Initialize SQLite database
 *   3. Start Sui client & services (mirror engine, event monitor)
 *   4. Launch Telegram bot
 *   5. Restore active positions from DB
 */

import { config } from "./config/index.js";
import { suiService } from "./sui/index.js";
import {
  initializeServices,
  shutdownServices,
  getServicesStatus,
} from "./services/index.js";
import { initializeDatabase, closeDatabase, positionRepo } from "./db/index.js";
import { createBot, startBot, stopBot } from "./bot/index.js";
import { mirrorEngine } from "./services/mirror-engine.js";
import { eventMonitor } from "./services/event-monitor.js";
import { deepBookService } from "./sui/deepbook.js";

async function main() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║           DeepMirror Backend              ║");
  console.log("║     Automated Liquidity Provision Bot     ║");
  console.log("╚═══════════════════════════════════════════╝");
  console.log();

  // ── Step 1: Configuration ──────────────────
  console.log("📋 Configuration:");
  console.log(`   Network:     ${config.sui.network}`);
  console.log(`   Environment: ${config.app.environment}`);
  console.log();

  if (!config.wallet.privateKey) {
    console.warn(
      "⚠️  WALLET_PRIVATE_KEY not set - transaction signing disabled",
    );
  } else {
    console.log(`   Wallet: ${suiService.getAddress()}`);
  }

  if (config.contracts.mirrorPackageId === "0x0") {
    console.warn("⚠️  MIRROR_PACKAGE_ID not set - contract calls will fail");
  }

  console.log();

  // ── Step 2: Database ───────────────────────
  try {
    initializeDatabase();
  } catch (error) {
    console.error("❌ Database init failed:", error);
    process.exit(1);
  }

  // ── Step 3: Services ───────────────────────
  try {
    await initializeServices();

    const status = getServicesStatus();
    console.log();
    console.log("📊 Service Status:");
    console.log(
      `   Mirror Engine: ${status.mirrorEngine.isRunning ? "🟢 Running" : "🔴 Stopped"}`,
    );
    console.log(
      `   Event Monitor: ${status.eventMonitor.isRunning ? "🟢 Running" : "🔴 Stopped"}`,
    );
  } catch (error) {
    console.error("❌ Service init failed:", error);
    process.exit(1);
  }

  // ── Step 4: Restore positions from DB ──────
  try {
    const activePositions = positionRepo.getAllActive();
    if (activePositions.length > 0) {
      console.log(
        `\n🔄 Restoring ${activePositions.length} active position(s)...`,
      );

      for (const pos of activePositions) {
        // Re-register with mirror engine
        mirrorEngine.registerPosition({
          positionId: pos.id,
          owner: suiService.getAddress(),
          targetMaker: pos.target_maker,
          poolKey: pos.pool_key,
          ratio: pos.ratio,
          active: true,
          balanceManagerKey: pos.balance_manager_key,
        });

        // Re-subscribe to pool events
        if (pos.pool_id) {
          eventMonitor.subscribeToPool(pos.pool_key, pos.pool_id, [
            pos.target_maker,
          ]);
        } else {
          // Resolve pool ID from SDK
          try {
            const poolId = await deepBookService.getPoolId(pos.pool_key);
            eventMonitor.subscribeToPool(pos.pool_key, poolId, [
              pos.target_maker,
            ]);
          } catch {
            console.warn(
              `   ⚠️  Could not resolve pool ID for ${pos.pool_key}`,
            );
          }
        }
      }
      console.log(`   Restored ${activePositions.length} position(s)`);
    }
  } catch (error) {
    console.warn("⚠️  Failed to restore positions:", error);
  }

  // ── Step 5: Telegram Bot ───────────────────
  if (
    config.telegram.botToken &&
    config.telegram.botToken !== "your_bot_token_here"
  ) {
    try {
      createBot();
      await startBot();
    } catch (error) {
      console.error("❌ Telegram bot failed to start:", error);
      console.log("   Continuing without bot...");
    }
  } else {
    console.log("\n⚠️  TELEGRAM_BOT_TOKEN not set - bot disabled");
    console.log("   Set it in .env to enable the Telegram interface");
  }

  console.log();
  console.log("✅ DeepMirror backend is running");
  console.log("   Press Ctrl+C to stop");

  // ── Graceful Shutdown ──────────────────────
  const shutdown = () => {
    console.log("\nShutting down...");
    stopBot();
    shutdownServices();
    closeDatabase();
    console.log("Goodbye! 👋");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
