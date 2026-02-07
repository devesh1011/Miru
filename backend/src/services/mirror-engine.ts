import { suiService } from "../sui/client.js";
import { deepBookService } from "../sui/deepbook.js";
import { mirrorContractService } from "../sui/mirror.js";
import {
  extractErrorMessage,
  isRetryableError,
  withRetry,
} from "../utils/errors.js";
import { analyticsService } from "./analytics.js";
import { riskManager } from "./risk-manager.js";
import { smartNotifier } from "./smart-notifier.js";
import { positionRepo } from "../db/repository.js";
import { zkLoginService } from "./zklogin.js";

/**
 * Maker order detected from DeepBook events
 */
export interface MakerOrderEvent {
  makerAddress: string;
  poolKey: string;
  orderId: string;
  price: number;
  quantity: number;
  isBid: boolean;
  timestamp: number;
}

/**
 * Tracked position for mirroring
 */
export interface TrackedPosition {
  positionId: string;
  owner: string;
  targetMaker: string;
  poolKey: string;
  ratio: number;
  active: boolean;
  balanceManagerKey: string;
  /** Non-custodial: on-chain MirrorCapability ID for delegated order recording */
  capabilityId?: string;
}

/**
 * Mirror execution result
 */
export interface MirrorExecutionResult {
  positionId: string;
  makerOrderId: string;
  mirroredOrderId: string;
  price: number;
  quantity: number;
  isBid: boolean;
  txDigest: string;
  success: boolean;
  error?: string;
}

/**
 * Mirroring Engine Service
 * Core logic for detecting maker orders and placing mirrored orders
 */
export class MirrorEngine {
  private trackedPositions: Map<string, TrackedPosition[]> = new Map();
  private isRunning: boolean = false;

  constructor() {
    // Initialize tracked positions map
    // Key: makerAddress:poolKey, Value: positions tracking that maker
  }

  /**
   * Start the mirroring engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("Mirror engine already running");
      return;
    }

    this.isRunning = true;
    console.log("Mirror engine started");

    // Load existing positions from database/contract
    await this.loadTrackedPositions();
  }

  /**
   * Stop the mirroring engine
   */
  stop(): void {
    this.isRunning = false;
    console.log("Mirror engine stopped");
  }

  /**
   * Load tracked positions from on-chain state
   */
  private async loadTrackedPositions(): Promise<void> {
    // This would typically load from a database
    // For now, we'll track positions in memory
    console.log("Loading tracked positions...");
  }

  /**
   * Register a new position for tracking
   */
  registerPosition(position: TrackedPosition): void {
    const key = `${position.targetMaker}:${position.poolKey}`;

    if (!this.trackedPositions.has(key)) {
      this.trackedPositions.set(key, []);
    }

    // Check if position already tracked
    const positions = this.trackedPositions.get(key)!;
    const existing = positions.find(
      (p) => p.positionId === position.positionId,
    );

    if (existing) {
      // Update existing position
      Object.assign(existing, position);
    } else {
      positions.push(position);
    }

    console.log(
      `Registered position ${position.positionId} tracking ${position.targetMaker}`,
    );
  }

  /**
   * Unregister a position from tracking
   */
  unregisterPosition(positionId: string): void {
    for (const [key, positions] of this.trackedPositions.entries()) {
      const index = positions.findIndex((p) => p.positionId === positionId);
      if (index !== -1) {
        positions.splice(index, 1);
        if (positions.length === 0) {
          this.trackedPositions.delete(key);
        }
        console.log(`Unregistered position ${positionId}`);
        return;
      }
    }
  }

  /**
   * Get positions tracking a specific maker
   */
  getPositionsForMaker(
    makerAddress: string,
    poolKey: string,
  ): TrackedPosition[] {
    const key = `${makerAddress}:${poolKey}`;
    return this.trackedPositions.get(key) || [];
  }

  /**
   * Find a tracked position by ID across all makers
   */
  findTrackedPosition(positionId: string): TrackedPosition | undefined {
    for (const positions of this.trackedPositions.values()) {
      const found = positions.find((p) => p.positionId === positionId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Process a maker order event and execute mirrors
   * Called when we detect a new order from a tracked maker
   */
  async processMakerOrder(
    event: MakerOrderEvent,
  ): Promise<MirrorExecutionResult[]> {
    if (!this.isRunning) {
      console.log("Mirror engine not running, skipping event");
      return [];
    }

    const positions = this.getPositionsForMaker(
      event.makerAddress,
      event.poolKey,
    );

    if (positions.length === 0) {
      console.log(
        `No positions tracking maker ${event.makerAddress} on ${event.poolKey}`,
      );
      return [];
    }

    console.log(
      `Processing maker order: ${event.isBid ? "BID" : "ASK"} ${event.quantity} @ ${event.price}`,
    );
    console.log(`   Found ${positions.length} positions to mirror`);

    const results: MirrorExecutionResult[] = [];

    for (const position of positions) {
      if (!position.active) {
        console.log(`   Skipping inactive position ${position.positionId}`);
        continue;
      }

      try {
        // Pre-trade risk check
        const riskCheck = await riskManager.checkPreTrade(
          position.owner,
          position.positionId,
          position.poolKey,
          (event.quantity * position.ratio) / 100,
          event.price,
        );

        if (!riskCheck.allowed) {
          console.log(`   Risk check blocked: ${riskCheck.reason}`);
          results.push({
            positionId: position.positionId,
            makerOrderId: event.orderId,
            mirroredOrderId: "",
            price: event.price,
            quantity: 0,
            isBid: event.isBid,
            txDigest: "",
            success: false,
            error: `Risk limit: ${riskCheck.reason}`,
          });
          continue;
        }

        const result = await this.executeMirrorOrder(position, event);
        results.push(result);

        // Post-trade: record analytics & notify
        try {
          const dbPosition = await positionRepo.getById(position.positionId);
          const userTelegramId = dbPosition?.user_telegram_id || position.owner;

          await analyticsService.recordOrderExecution(
            position.positionId,
            userTelegramId,
            result.price,
            result.quantity,
            result.isBid,
            result.success,
          );

          // Smart notification with P&L context
          await smartNotifier.notifyOrderExecuted(result);

          // Post-trade risk checks (stop loss, take profit)
          if (result.success) {
            await riskManager.checkPostTrade(
              userTelegramId,
              position.positionId,
              position.poolKey,
            );
          }
        } catch (analyticsError) {
          console.error(`   Analytics/notification error:`, analyticsError);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `   Error mirroring for position ${position.positionId}:`,
          errorMessage,
        );
        results.push({
          positionId: position.positionId,
          makerOrderId: event.orderId,
          mirroredOrderId: "",
          price: event.price,
          quantity: 0,
          isBid: event.isBid,
          txDigest: "",
          success: false,
          error: errorMessage,
        });
      }
    }

    return results;
  }

  /**
   * Execute a single mirror order
   */
  private async executeMirrorOrder(
    position: TrackedPosition,
    makerOrder: MakerOrderEvent,
  ): Promise<MirrorExecutionResult> {
    // Calculate mirrored quantity based on ratio
    const mirroredQuantity = (makerOrder.quantity * position.ratio) / 100;

    if (mirroredQuantity <= 0) {
      return {
        positionId: position.positionId,
        makerOrderId: makerOrder.orderId,
        mirroredOrderId: "",
        price: makerOrder.price,
        quantity: 0,
        isBid: makerOrder.isBid,
        txDigest: "",
        success: false,
        error: "Calculated mirror quantity is zero or negative",
      };
    }

    console.log(
      `   Mirroring: ${mirroredQuantity} (${position.ratio}% of ${makerOrder.quantity})`,
    );

    // Place the mirrored order via DeepBook SDK (with retry for transient failures)
    let txDigest: string;
    try {
      txDigest = await withRetry(
        () =>
          deepBookService.placeLimitOrder({
            poolKey: position.poolKey,
            managerKey: position.balanceManagerKey,
            price: makerOrder.price,
            quantity: mirroredQuantity,
            isBid: makerOrder.isBid,
            clientOrderId: Date.now(),
          }),
        {
          maxRetries: 2,
          baseDelayMs: 1500,
          label: `Mirror order for ${position.positionId}`,
        },
      );
    } catch (orderError) {
      const errMsg = extractErrorMessage(orderError);
      console.error(`   Failed to place mirror order: ${errMsg}`);

      // Detect specific failures
      if (/insufficient|balance|gas/i.test(errMsg)) {
        console.error(
          `   ⚠️ Insufficient balance — consider pausing position ${position.positionId}`,
        );
      }

      return {
        positionId: position.positionId,
        makerOrderId: makerOrder.orderId,
        mirroredOrderId: "",
        price: makerOrder.price,
        quantity: mirroredQuantity,
        isBid: makerOrder.isBid,
        txDigest: "",
        success: false,
        error: errMsg,
      };
    }

    console.log(`   Order placed: ${txDigest}`);

    // Record the order in the contract for tracking
    try {
      if (position.capabilityId) {
        // Non-custodial: use capability-based recording
        await mirrorContractService.recordOrderWithCapability(
          position.capabilityId,
          position.positionId,
          makerOrder.orderId,
        );
      } else {
        // Custodial: direct recording (position owned by backend)
        await mirrorContractService.recordOrder(
          position.positionId,
          makerOrder.orderId,
        );
      }
    } catch (recordError) {
      console.error(
        `   Warning: Failed to record order in contract:`,
        recordError,
      );
    }

    return {
      positionId: position.positionId,
      makerOrderId: makerOrder.orderId,
      mirroredOrderId: "",
      price: makerOrder.price,
      quantity: mirroredQuantity,
      isBid: makerOrder.isBid,
      txDigest,
      success: true,
    };
  }

  /**
   * Handle maker order cancellation
   * Cancel corresponding mirrored orders
   */
  async processMakerOrderCancellation(
    makerAddress: string,
    poolKey: string,
    orderId: string,
  ): Promise<void> {
    const positions = this.getPositionsForMaker(makerAddress, poolKey);

    for (const position of positions) {
      if (!position.active) continue;

      try {
        const positionData = await mirrorContractService.getPosition(
          position.positionId,
        );
        if (!positionData) continue;

        console.log(
          `Maker cancelled order ${orderId}, checking mirrors for position ${position.positionId}`,
        );
      } catch (error) {
        console.error(
          `Error processing cancellation for position ${position.positionId}:`,
          error,
        );
      }
    }
  }

  /**
   * Create a new mirror position (full flow)
   * 1. Create position on-chain
   * 2. Register for tracking
   */
  async createMirrorPosition(params: {
    targetMaker: string;
    poolKey: string;
    ratio: number;
    balanceManagerKey: string;
  }): Promise<{ positionId: string; txDigest: string }> {
    // Get pool ID from pool key via SDK
    const poolId = await deepBookService.getPoolId(params.poolKey);

    // Create position on-chain
    const { digest, positionId } = await mirrorContractService.createPosition(
      params.targetMaker,
      params.ratio,
      poolId,
    );

    // Register for tracking
    this.registerPosition({
      positionId,
      owner: suiService.getAddress(),
      targetMaker: params.targetMaker,
      poolKey: params.poolKey,
      ratio: params.ratio,
      active: true,
      balanceManagerKey: params.balanceManagerKey,
    });

    console.log(`Created mirror position: ${positionId}`);
    console.log(`   Target: ${params.targetMaker}`);
    console.log(`   Pool: ${params.poolKey}`);
    console.log(`   Ratio: ${params.ratio}%`);

    return { positionId, txDigest: digest };
  }

  /**
   * Stop mirroring a position.
   * If telegramId is provided, signs the on-chain tx via zkLogin (user-owned object).
   * Otherwise falls back to backend signer (only works for backend-owned objects).
   */
  async stopMirroring(
    positionId: string,
    telegramId?: string,
  ): Promise<string> {
    let txDigest: string;

    if (telegramId) {
      // User-owned position: sign via zkLogin
      txDigest = await zkLoginService.signAndExecute(
        telegramId,
        mirrorContractService.buildToggleActive(positionId),
      );
    } else {
      // Backend-owned position: direct signing
      txDigest = await mirrorContractService.toggleActive(positionId);
    }

    // Update local tracking
    for (const positions of this.trackedPositions.values()) {
      const position = positions.find((p) => p.positionId === positionId);
      if (position) {
        position.active = false;
        break;
      }
    }

    console.log(`Paused mirroring for position ${positionId}`);
    return txDigest;
  }

  /**
   * Resume mirroring a position.
   * If telegramId is provided, signs the on-chain tx via zkLogin.
   */
  async resumeMirroring(
    positionId: string,
    telegramId?: string,
  ): Promise<string> {
    let txDigest: string;

    if (telegramId) {
      txDigest = await zkLoginService.signAndExecute(
        telegramId,
        mirrorContractService.buildToggleActive(positionId),
      );
    } else {
      txDigest = await mirrorContractService.toggleActive(positionId);
    }

    // Update local tracking
    for (const positions of this.trackedPositions.values()) {
      const position = positions.find((p) => p.positionId === positionId);
      if (position) {
        position.active = true;
        break;
      }
    }

    console.log(`Resumed mirroring for position ${positionId}`);
    return txDigest;
  }

  /**
   * Close a mirror position completely.
   * If telegramId is provided, signs the on-chain tx via zkLogin.
   */
  async closePosition(
    positionId: string,
    telegramId?: string,
  ): Promise<string> {
    // First, cancel all active orders for this position
    const positionData = await mirrorContractService.getPosition(positionId);

    if (positionData && positionData.activeOrders.length > 0) {
      const trackedPos = this.findTrackedPosition(positionId);
      if (trackedPos?.capabilityId) {
        await mirrorContractService.clearOrdersWithCapability(
          trackedPos.capabilityId,
          positionId,
        );
      } else {
        await mirrorContractService.clearOrders(positionId);
      }
    }

    let txDigest: string;
    if (telegramId) {
      txDigest = await zkLoginService.signAndExecute(
        telegramId,
        mirrorContractService.buildClosePosition(positionId),
      );
    } else {
      txDigest = await mirrorContractService.closePosition(positionId);
    }

    // Unregister from tracking
    this.unregisterPosition(positionId);

    console.log(`Closed position ${positionId}`);
    return txDigest;
  }

  /**
   * Get current engine status
   */
  getStatus(): {
    isRunning: boolean;
    trackedMakers: number;
    totalPositions: number;
  } {
    let totalPositions = 0;
    for (const positions of this.trackedPositions.values()) {
      totalPositions += positions.length;
    }

    return {
      isRunning: this.isRunning,
      trackedMakers: this.trackedPositions.size,
      totalPositions,
    };
  }
}

// Singleton instance
export const mirrorEngine = new MirrorEngine();
