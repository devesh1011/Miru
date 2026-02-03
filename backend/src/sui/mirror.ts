import { Transaction } from "@mysten/sui/transactions";
import { suiService } from "./client.js";
import { config } from "../config/index.js";

/**
 * Mirror Contract Integration Service
 * Interfaces with the deepmirror::mirror Move contract for position management
 *
 * Updated for @mysten/sui@2.3.0:
 * - getObject takes { objectId } not { id }
 * - Response has .object not .data
 * - Object JSON content via include: { json: true }
 * - listOwnedObjects replaces getOwnedObjects
 */
export class MirrorContractService {
  private packageId: string;
  private protocolConfigId: string;

  constructor() {
    this.packageId = config.contracts.mirrorPackageId;
    this.protocolConfigId = config.contracts.protocolConfigId;
  }

  /**
   * Create a new mirror position on-chain
   */
  async createPosition(
    targetMaker: string,
    ratio: number,
    poolId: string,
  ): Promise<{ digest: string; positionId: string }> {
    const tx = new Transaction();
    const clockId = "0x6"; // Sui Clock object

    // Call deepmirror::mirror::create_position
    const position = tx.moveCall({
      target: `${this.packageId}::mirror::create_position`,
      arguments: [
        tx.object(this.protocolConfigId),
        tx.pure.address(targetMaker),
        tx.pure.u64(ratio.toString()),
        tx.pure.id(poolId),
        tx.object(clockId),
      ],
    });

    // Transfer the position to the caller (owned object)
    tx.transferObjects([position], suiService.getAddress());

    const txResult = await suiService.executeTransactionFull(tx);

    // Find the created MirrorPosition object from objectTypes
    const objectTypes = txResult.objectTypes ?? {};
    const effects = txResult.effects;
    const createdObjects = effects?.changedObjects?.filter(
      (obj: any) => obj.idOperation === "Created",
    ) || [];

    const positionObj = createdObjects.find((obj: any) => {
      const objType = objectTypes[obj.objectId];
      return objType && objType.includes("MirrorPosition");
    });

    if (!positionObj) {
      throw new Error("Position object not found in transaction result");
    }

    return {
      digest: txResult.digest,
      positionId: (positionObj as any).objectId,
    };
  }

  /**
   * Update position mirror ratio
   */
  async updateRatio(positionId: string, newRatio: number): Promise<string> {
    const tx = new Transaction();
    const clockId = "0x6";

    tx.moveCall({
      target: `${this.packageId}::mirror::update_ratio`,
      arguments: [
        tx.object(positionId),
        tx.pure.u64(newRatio.toString()),
        tx.object(clockId),
      ],
    });

    return suiService.executeTransaction(tx);
  }

  /**
   * Toggle position active status (pause/resume)
   */
  async toggleActive(positionId: string): Promise<string> {
    const tx = new Transaction();
    const clockId = "0x6";

    tx.moveCall({
      target: `${this.packageId}::mirror::toggle_active`,
      arguments: [tx.object(positionId), tx.object(clockId)],
    });

    return suiService.executeTransaction(tx);
  }

  /**
   * Record an order placement in the contract
   */
  async recordOrder(positionId: string, orderId: string): Promise<string> {
    const tx = new Transaction();
    const clockId = "0x6";

    tx.moveCall({
      target: `${this.packageId}::mirror::record_order`,
      arguments: [
        tx.object(this.protocolConfigId),
        tx.object(positionId),
        tx.pure.u128(orderId),
        tx.object(clockId),
      ],
    });

    return suiService.executeTransaction(tx);
  }

  /**
   * Remove an order from tracking
   */
  async removeOrder(positionId: string, orderId: string): Promise<string> {
    const tx = new Transaction();
    const clockId = "0x6";

    tx.moveCall({
      target: `${this.packageId}::mirror::remove_order`,
      arguments: [
        tx.object(positionId),
        tx.pure.u128(orderId),
        tx.object(clockId),
      ],
    });

    return suiService.executeTransaction(tx);
  }

  /**
   * Clear all active orders from position
   */
  async clearOrders(positionId: string): Promise<string> {
    const tx = new Transaction();
    const clockId = "0x6";

    tx.moveCall({
      target: `${this.packageId}::mirror::clear_orders`,
      arguments: [tx.object(positionId), tx.object(clockId)],
    });

    return suiService.executeTransaction(tx);
  }

  /**
   * Close and delete a position
   */
  async closePosition(positionId: string): Promise<string> {
    const tx = new Transaction();
    const clockId = "0x6";

    tx.moveCall({
      target: `${this.packageId}::mirror::close_position`,
      arguments: [tx.object(positionId), tx.object(clockId)],
    });

    return suiService.executeTransaction(tx);
  }

  /**
   * Get position details from on-chain state
   * Uses new @mysten/sui@2.3.0 API:
   *   getObject({ objectId, include: { json: true } })
   *   result.object.json contains the JSON fields
   */
  async getPosition(positionId: string): Promise<MirrorPositionData | null> {
    try {
      const result = await suiService.getObject(positionId);
      const fields = result.object?.json as any;

      if (!fields) {
        return null;
      }

      return {
        id: positionId,
        owner: fields.owner,
        targetMaker: fields.target_maker,
        ratio: parseInt(fields.ratio),
        poolId: fields.pool_id,
        activeOrders: fields.active_orders || [],
        totalOrdersPlaced: parseInt(fields.total_orders_placed),
        createdAt: parseInt(fields.created_at),
        updatedAt: parseInt(fields.updated_at),
        active: fields.active,
      };
    } catch (error) {
      console.error("Error fetching position:", error);
      return null;
    }
  }

  /**
   * Get all positions owned by an address
   * Uses listOwnedObjects (replaces getOwnedObjects in @mysten/sui@2.3.0)
   */
  async getPositionsByOwner(owner: string): Promise<MirrorPositionData[]> {
    const positionType = `${this.packageId}::mirror::MirrorPosition`;

    const result = await suiService.listOwnedObjects(owner, positionType);

    const positions: MirrorPositionData[] = [];

    for (const obj of result.objects || []) {
      const fields = obj.json as any;
      if (fields) {
        positions.push({
          id: obj.objectId,
          owner: fields.owner,
          targetMaker: fields.target_maker,
          ratio: parseInt(fields.ratio),
          poolId: fields.pool_id,
          activeOrders: fields.active_orders || [],
          totalOrdersPlaced: parseInt(fields.total_orders_placed),
          createdAt: parseInt(fields.created_at),
          updatedAt: parseInt(fields.updated_at),
          active: fields.active,
        });
      }
    }

    return positions;
  }

  /**
   * Get protocol config state
   */
  async getProtocolConfig(): Promise<ProtocolConfigData | null> {
    try {
      const result = await suiService.getObject(this.protocolConfigId);
      const fields = result.object?.json as any;

      if (!fields) {
        return null;
      }

      return {
        id: this.protocolConfigId,
        paused: fields.paused,
        totalPositions: parseInt(fields.total_positions),
        totalOrders: parseInt(fields.total_orders),
        version: parseInt(fields.version),
      };
    } catch (error) {
      console.error("Error fetching protocol config:", error);
      return null;
    }
  }
}

// Type definitions
export interface MirrorPositionData {
  id: string;
  owner: string;
  targetMaker: string;
  ratio: number;
  poolId: string;
  activeOrders: string[];
  totalOrdersPlaced: number;
  createdAt: number;
  updatedAt: number;
  active: boolean;
}

export interface ProtocolConfigData {
  id: string;
  paused: boolean;
  totalPositions: number;
  totalOrders: number;
  version: number;
}

// Singleton instance
export const mirrorContractService = new MirrorContractService();
