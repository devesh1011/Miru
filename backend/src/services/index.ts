/**
 * Miru Services
 *
 * Main service exports for the mirroring backend
 */

// Mirror Engine - Core mirroring logic
export {
  MirrorEngine,
  mirrorEngine,
  type MakerOrderEvent,
  type TrackedPosition,
  type MirrorExecutionResult,
} from "./mirror-engine.js";

// Event Monitor - DeepBook event subscription
export { EventMonitorService, eventMonitor } from "./event-monitor.js";

// Position Manager - High-level position management
export {
  PositionManagerService,
  positionManager,
  type CreatePositionParams,
  type PositionStatus,
} from "./position-manager.js";

// Discovery - Find top makers via DeepBook Indexer
export {
  getPools,
  getPoolSummaries,
  getOrderBook,
  discoverTopMakers,
  getPoolOverview,
  type IndexerPool,
  type PoolSummary,
  type IndexerOrder,
  type OrderBookData,
  type MakerProfile,
} from "./discover.js";

// zkLogin - Non-custodial wallet management
export {
  ZkLoginService,
  zkLoginService,
  type ZkLoginSession,
  type ZkLoginAuth,
  type PartialZkLoginSignature,
} from "./zklogin.js";

// Transaction Builder - Builds unsigned PTBs for zkLogin users
export { TxBuilderService, txBuilderService } from "./tx-builder.js";

// Analytics - P&L tracking and portfolio analytics
export { AnalyticsService, analyticsService } from "./analytics.js";

// Smart Notifier - Enhanced notifications with P&L context
export { SmartNotificationService, smartNotifier } from "./smart-notifier.js";

// Risk Manager - Pre/post-trade risk checks
export {
  RiskManagementService,
  riskManager,
  type RiskCheckResult,
} from "./risk-manager.js";

// Import singletons for use in functions below
import { mirrorEngine as _mirrorEngine } from "./mirror-engine.js";
import { eventMonitor as _eventMonitor } from "./event-monitor.js";
import { smartNotifier as _smartNotifier } from "./smart-notifier.js";

/**
 * Initialize all services
 */
export async function initializeServices(): Promise<void> {
  console.log("Initializing Miru services...");

  // Start event monitor (listens for DeepBook events)
  await _eventMonitor.start();

  // Start mirror engine (processes events and executes mirrors)
  await _mirrorEngine.start();

  // Start smart notifier (periodic balance checks, daily summaries)
  _smartNotifier.start();

  console.log("All services initialized");
}

/**
 * Shutdown all services gracefully
 */
export function shutdownServices(): void {
  console.log("Shutting down Miru services...");

  _smartNotifier.stop();
  _mirrorEngine.stop();
  _eventMonitor.stop();

  console.log("All services stopped");
}

/**
 * Get combined status of all services
 */
export function getServicesStatus() {
  return {
    mirrorEngine: _mirrorEngine.getStatus(),
    eventMonitor: _eventMonitor.getStatus(),
  };
}
