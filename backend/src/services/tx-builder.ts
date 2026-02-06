/**
 * Transaction Builder Service
 *
 * Builds unsigned Programmable Transaction Blocks (PTBs) for zkLogin users.
 * These transactions are built on the backend, then signed by the user's
 * ephemeral keypair via the zkLogin service.
 *
 * Key functions:
 *   - buildCreatePosition: Create a new mirror position
 *   - buildGrantCapability: Grant backend operator capability
 *   - buildRevokeCapability: Revoke a capability
 *
 * The backend wallet address is the operator that receives capabilities.
 */

import { Transaction } from "@mysten/sui/transactions";
import { config } from "../config/index.js";
import { suiService } from "../sui/client.js";

const CLOCK_ID = "0x6";

export class TxBuilderService {
  private packageId: string;
  private protocolConfigId: string;

  constructor() {
    this.packageId = config.contracts.mirrorPackageId;
    this.protocolConfigId = config.contracts.protocolConfigId;
  }

  /**
   * Build a transaction to create a new mirror position.
   * The position will be owned by the zkLogin user's address.
   *
   * @param userAddress - User's zkLogin address (sender)
   * @param targetMaker - Address of the maker to mirror
   * @param ratio - Mirror percentage (1-100)
   * @param poolId - DeepBook pool ID
   * @returns Function to populate a Transaction
   */
  buildCreatePosition(
    userAddress: string,
    targetMaker: string,
    ratio: number,
    poolId: string,
  ): (tx: Transaction) => void {
    return (tx: Transaction) => {
      const position = tx.moveCall({
        target: `${this.packageId}::mirror::create_position`,
        arguments: [
          tx.object(this.protocolConfigId),
          tx.pure.address(targetMaker),
          tx.pure.u64(ratio.toString()),
          tx.pure.id(poolId),
          tx.object(CLOCK_ID),
        ],
      });

      // Transfer position to the user
      tx.transferObjects([position], userAddress);
    };
  }

  /**
   * Build a transaction to grant a MirrorCapability to the backend operator.
   * This allows the backend to record/remove orders on the user's position.
   *
   * @param positionId - On-chain position object ID
   * @param operatorAddress - Backend wallet address (the operator)
   * @param maxOrderSize - Max order size limit (0 = unlimited)
   * @param expiresAt - Expiration timestamp in ms (0 = no expiry)
   * @returns Function to populate a Transaction
   */
  buildGrantCapability(
    positionId: string,
    operatorAddress: string,
    maxOrderSize: number = 0,
    expiresAt: number = 0,
  ): (tx: Transaction) => void {
    return (tx: Transaction) => {
      const cap = tx.moveCall({
        target: `${this.packageId}::mirror::grant_capability`,
        arguments: [
          tx.object(positionId),
          tx.pure.address(operatorAddress),
          tx.pure.u64(maxOrderSize.toString()),
          tx.pure.u64(expiresAt.toString()),
          tx.object(CLOCK_ID),
        ],
      });

      // Transfer capability to the operator (backend)
      tx.transferObjects([cap], operatorAddress);
    };
  }

  /**
   * Build a transaction to revoke a MirrorCapability.
   * Called by the position owner to remove backend's authority.
   *
   * NOTE: The capability object must be passed by the owner. Since the
   * capability is owned by the operator, we need the operator to transfer
   * it back first, or use a different pattern. For simplicity, we'll
   * have the backend transfer it back to the user who then revokes it.
   *
   * @param capabilityId - On-chain capability object ID
   * @param positionId - On-chain position object ID
   * @returns Function to populate a Transaction
   */
  buildRevokeCapability(
    capabilityId: string,
    positionId: string,
  ): (tx: Transaction) => void {
    return (tx: Transaction) => {
      tx.moveCall({
        target: `${this.packageId}::mirror::revoke_capability`,
        arguments: [
          tx.object(capabilityId),
          tx.object(positionId),
          tx.object(CLOCK_ID),
        ],
      });
    };
  }

  /**
   * Build a combined transaction: create position + grant capability.
   * This is the most common flow — user creates a position and immediately
   * grants the backend permission to operate it.
   *
   * @param userAddress - User's zkLogin address
   * @param targetMaker - Address of the maker to mirror
   * @param ratio - Mirror percentage (1-100)
   * @param poolId - DeepBook pool ID
   * @param operatorAddress - Backend wallet address
   * @param maxOrderSize - Max order size (0 = unlimited)
   * @param expiresAt - Expiry timestamp in ms (0 = no expiry)
   * @returns Function to populate a Transaction
   */
  buildCreatePositionAndGrant(
    userAddress: string,
    targetMaker: string,
    ratio: number,
    poolId: string,
    operatorAddress: string,
    maxOrderSize: number = 0,
    expiresAt: number = 0,
  ): (tx: Transaction) => void {
    return (tx: Transaction) => {
      // Step 1: Create position
      const position = tx.moveCall({
        target: `${this.packageId}::mirror::create_position`,
        arguments: [
          tx.object(this.protocolConfigId),
          tx.pure.address(targetMaker),
          tx.pure.u64(ratio.toString()),
          tx.pure.id(poolId),
          tx.object(CLOCK_ID),
        ],
      });

      // Step 2: Grant capability (using the just-created position)
      const cap = tx.moveCall({
        target: `${this.packageId}::mirror::grant_capability`,
        arguments: [
          position,
          tx.pure.address(operatorAddress),
          tx.pure.u64(maxOrderSize.toString()),
          tx.pure.u64(expiresAt.toString()),
          tx.object(CLOCK_ID),
        ],
      });

      // Transfer position to user, capability to operator
      tx.transferObjects([position], userAddress);
      tx.transferObjects([cap], operatorAddress);
    };
  }

  /**
   * Build a transaction to toggle position active status.
   *
   * @param positionId - On-chain position object ID
   * @returns Function to populate a Transaction
   */
  buildToggleActive(positionId: string): (tx: Transaction) => void {
    return (tx: Transaction) => {
      tx.moveCall({
        target: `${this.packageId}::mirror::toggle_active`,
        arguments: [tx.object(positionId), tx.object(CLOCK_ID)],
      });
    };
  }

  /**
   * Build a transaction to update position ratio.
   *
   * @param positionId - On-chain position object ID
   * @param newRatio - New mirror ratio (1-100)
   * @returns Function to populate a Transaction
   */
  buildUpdateRatio(
    positionId: string,
    newRatio: number,
  ): (tx: Transaction) => void {
    return (tx: Transaction) => {
      tx.moveCall({
        target: `${this.packageId}::mirror::update_ratio`,
        arguments: [
          tx.object(positionId),
          tx.pure.u64(newRatio.toString()),
          tx.object(CLOCK_ID),
        ],
      });
    };
  }

  /**
   * Get the backend operator address
   */
  getOperatorAddress(): string {
    return suiService.getAddress();
  }
}

// Singleton
export const txBuilderService = new TxBuilderService();
