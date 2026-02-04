import { mirrorContractService, MirrorPositionData } from "../sui/mirror.js";
import { deepBookService } from "../sui/deepbook.js";
import { mirrorEngine, TrackedPosition } from "./mirror-engine.js";
import { eventMonitor } from "./event-monitor.js";
import { suiService } from "../sui/client.js";

/**
 * Position creation parameters
 */
export interface CreatePositionParams {
  targetMaker: string;
  poolKey: string;
  ratio: number;
  balanceManagerKey: string;
  initialDepositBaseAmount?: number;
  initialDepositQuoteAmount?: number;
}

/**
 * Position status including on-chain and tracking data
 */
export interface PositionStatus {
  positionId: string;
  owner: string;
  targetMaker: string;
  poolKey: string;
  ratio: number;
  isActive: boolean;
  activeOrders: string[];
  totalOrdersPlaced: number;
  isTracking: boolean;
  createdAt?: number;
}

/**
 * Position Manager Service
 * High-level position management coordinating contract, engine, and monitor
 */
export class PositionManagerService {
  constructor() {}

  /**
   * Create a new mirror position
   * Full flow: validate -> create on-chain -> register tracking -> subscribe to events
   */
  async createPosition(params: CreatePositionParams): Promise<{
    positionId: string;
    txDigest: string;
  }> {
    // Validate parameters
    this.validatePositionParams(params);

    // Get pool ID from the SDK
    const poolId = await deepBookService.getPoolId(params.poolKey);

    console.log(`Creating mirror position...`);
    console.log(`   Target maker: ${params.targetMaker}`);
    console.log(`   Pool: ${params.poolKey} (${poolId})`);
    console.log(`   Ratio: ${params.ratio}%`);

    // Create position via mirror engine (handles both on-chain and tracking)
    const { positionId, txDigest } = await mirrorEngine.createMirrorPosition({
      targetMaker: params.targetMaker,
      poolKey: params.poolKey,
      ratio: params.ratio,
      balanceManagerKey: params.balanceManagerKey,
    });

    // Subscribe to pool events for this maker
    eventMonitor.subscribeToPool(params.poolKey, poolId, [params.targetMaker]);

    // Handle initial deposits if specified
    if (params.initialDepositBaseAmount || params.initialDepositQuoteAmount) {
      await this.handleInitialDeposits(
        params.balanceManagerKey,
        params.poolKey,
        params.initialDepositBaseAmount,
        params.initialDepositQuoteAmount,
      );
    }

    console.log(`Position created: ${positionId}`);
    return { positionId, txDigest };
  }

  /**
   * Get position status
   */
  async getPosition(positionId: string): Promise<PositionStatus | null> {
    // Get on-chain data
    const onChainData = await mirrorContractService.getPosition(positionId);

    if (!onChainData) {
      return null;
    }

    // Get tracking status from engine
    const engineStatus = mirrorEngine.getStatus();

    return {
      positionId,
      owner: onChainData.owner,
      targetMaker: onChainData.targetMaker,
      poolKey: this.getPoolKeyFromId(onChainData.poolId),
      ratio: onChainData.ratio,
      isActive: onChainData.active,
      activeOrders: onChainData.activeOrders,
      totalOrdersPlaced: onChainData.totalOrdersPlaced,
      isTracking: engineStatus.isRunning,
    };
  }

  /**
   * Get all positions for current user
   */
  async getMyPositions(): Promise<PositionStatus[]> {
    const ownerAddress = suiService.getAddress();
    const positions =
      await mirrorContractService.getPositionsByOwner(ownerAddress);

    return Promise.all(
      positions.map(async (pos: MirrorPositionData) => {
        const onChainData = await mirrorContractService.getPosition(pos.id);
        if (!onChainData) return null;

        return {
          positionId: pos.id,
          owner: onChainData.owner,
          targetMaker: onChainData.targetMaker,
          poolKey: this.getPoolKeyFromId(onChainData.poolId),
          ratio: onChainData.ratio,
          isActive: onChainData.active,
          activeOrders: onChainData.activeOrders,
          totalOrdersPlaced: onChainData.totalOrdersPlaced,
          isTracking: mirrorEngine.getStatus().isRunning,
        };
      }),
    ).then((results) => results.filter((r): r is PositionStatus => r !== null));
  }

  /**
   * Update position ratio
   */
  async updatePositionRatio(
    positionId: string,
    newRatio: number,
  ): Promise<string> {
    // Validate ratio
    if (newRatio < 1 || newRatio > 100) {
      throw new Error("Ratio must be between 1 and 100");
    }

    const txDigest = await mirrorContractService.updateRatio(
      positionId,
      newRatio,
    );

    // Update in engine tracking
    const onChainData = await mirrorContractService.getPosition(positionId);
    if (onChainData) {
      mirrorEngine.registerPosition({
        positionId,
        owner: onChainData.owner,
        targetMaker: onChainData.targetMaker,
        poolKey: this.getPoolKeyFromId(onChainData.poolId),
        ratio: newRatio,
        active: onChainData.active,
        balanceManagerKey: "", // Would need to store this
      });
    }

    console.log(`Updated ratio for ${positionId} to ${newRatio}%`);
    return txDigest;
  }

  /**
   * Pause mirroring for a position
   */
  async pausePosition(positionId: string): Promise<string> {
    const txDigest = await mirrorEngine.stopMirroring(positionId);
    console.log(`Paused position ${positionId}`);
    return txDigest;
  }

  /**
   * Resume mirroring for a position
   */
  async resumePosition(positionId: string): Promise<string> {
    const txDigest = await mirrorEngine.resumeMirroring(positionId);
    console.log(`Resumed position ${positionId}`);
    return txDigest;
  }

  /**
   * Close a position and cleanup
   */
  async closePosition(positionId: string): Promise<string> {
    // Get position data before closing
    const positionData = await mirrorContractService.getPosition(positionId);

    if (!positionData) {
      throw new Error(`Position ${positionId} not found`);
    }

    // Close via engine (handles order cleanup and contract call)
    const txDigest = await mirrorEngine.closePosition(positionId);

    // Unsubscribe maker from event monitor if no other positions tracking them
    const poolKey = this.getPoolKeyFromId(positionData.poolId);
    const remainingPositions = mirrorEngine.getPositionsForMaker(
      positionData.targetMaker,
      poolKey,
    );

    if (remainingPositions.length === 0) {
      eventMonitor.unsubscribeMaker(poolKey, positionData.targetMaker);
    }

    console.log(`Closed position ${positionId}`);
    return txDigest;
  }

  /**
   * Get position orders with their current status
   */
  async getPositionOrders(positionId: string): Promise<
    {
      orderId: string;
      status: "open" | "filled" | "canceled";
    }[]
  > {
    const positionData = await mirrorContractService.getPosition(positionId);

    if (!positionData) {
      return [];
    }

    // Get status for each order
    return positionData.activeOrders.map((orderId) => ({
      orderId,
      status: "open" as const, // Would need to check DeepBook for actual status
    }));
  }

  /**
   * Validate position parameters
   */
  private validatePositionParams(params: CreatePositionParams): void {
    if (!params.targetMaker || params.targetMaker.length < 10) {
      throw new Error("Invalid target maker address");
    }

    if (!params.poolKey) {
      throw new Error("Pool key is required");
    }

    if (params.ratio < 1 || params.ratio > 100) {
      throw new Error("Ratio must be between 1 and 100");
    }

    if (!params.balanceManagerKey) {
      throw new Error("Balance manager key is required");
    }
  }

  /**
   * Handle initial deposits for a new position
   */
  private async handleInitialDeposits(
    balanceManagerKey: string,
    _poolKey: string,
    baseAmount?: number,
    quoteAmount?: number,
  ): Promise<void> {
    if (baseAmount && baseAmount > 0) {
      console.log(`   Depositing ${baseAmount} base token...`);
      // Would use deepBookService.deposit() here
    }

    if (quoteAmount && quoteAmount > 0) {
      console.log(`   Depositing ${quoteAmount} quote token...`);
      // Would use deepBookService.deposit() here
    }
  }

  /**
   * Get pool key from pool ID
   * In production, this would query a mapping or SDK
   */
  private getPoolKeyFromId(_poolId: string): string {
    // This would be a reverse lookup from pool ID to pool key
    // For now, return a placeholder
    return "DEEP_SUI"; // Default to DEEP_SUI for MVP
  }
}

// Singleton instance
export const positionManager = new PositionManagerService();
