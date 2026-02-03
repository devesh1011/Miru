import { suiService } from "../sui/client.js";
import { mirrorEngine, MakerOrderEvent } from "./mirror-engine.js";
import { config } from "../config/index.js";

/**
 * DeepBook order event types
 */
type OrderEventType =
  | "OrderPlaced"
  | "OrderFilled"
  | "OrderCanceled"
  | "OrderModified";

/**
 * Raw DeepBook event from chain
 */
interface DeepBookOrderEvent {
  type: OrderEventType;
  orderId: string;
  poolId: string;
  maker: string;
  price: string;
  quantity: string;
  isBid: boolean;
  timestamp: string;
}

/**
 * Pool subscription configuration
 */
interface PoolSubscription {
  poolKey: string;
  poolId: string;
  trackedMakers: Set<string>;
}

/**
 * Event Monitor Service
 * Subscribes to DeepBook events and routes them to the mirror engine
 */
export class EventMonitorService {
  private isRunning: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastCursor: Map<string, string> = new Map();
  private subscriptions: Map<string, PoolSubscription> = new Map();

  // Poll interval in milliseconds
  private readonly POLL_INTERVAL_MS = 2000;

  constructor() {}

  /**
   * Start the event monitor
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("Event monitor already running");
      return;
    }

    this.isRunning = true;
    console.log("Event monitor started");

    // Start polling for events
    this.startPolling();
  }

  /**
   * Stop the event monitor
   */
  stop(): void {
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    console.log("Event monitor stopped");
  }

  /**
   * Subscribe to a pool's events for specific makers
   */
  subscribeToPool(poolKey: string, poolId: string, makers: string[]): void {
    if (!this.subscriptions.has(poolKey)) {
      this.subscriptions.set(poolKey, {
        poolKey,
        poolId,
        trackedMakers: new Set(),
      });
    }

    const subscription = this.subscriptions.get(poolKey)!;
    makers.forEach((maker) => subscription.trackedMakers.add(maker));

    console.log(`Subscribed to ${poolKey} for ${makers.length} maker(s)`);
  }

  /**
   * Unsubscribe a maker from a pool
   */
  unsubscribeMaker(poolKey: string, maker: string): void {
    const subscription = this.subscriptions.get(poolKey);
    if (subscription) {
      subscription.trackedMakers.delete(maker);

      // Remove pool subscription if no more makers
      if (subscription.trackedMakers.size === 0) {
        this.subscriptions.delete(poolKey);
        this.lastCursor.delete(poolKey);
      }
    }
  }

  /**
   * Start polling for events
   */
  private startPolling(): void {
    this.pollInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.pollEvents();
      } catch (error) {
        console.error("Error polling events:", error);
      }
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Poll for new events from all subscribed pools
   */
  private async pollEvents(): Promise<void> {
    for (const [poolKey, subscription] of this.subscriptions.entries()) {
      if (subscription.trackedMakers.size === 0) continue;

      try {
        await this.pollPoolEvents(subscription);
      } catch (error) {
        console.error(`Error polling events for ${poolKey}:`, error);
      }
    }
  }

  /**
   * Poll events for a specific pool
   */
  private async pollPoolEvents(subscription: PoolSubscription): Promise<void> {
    // Query events from DeepBook package
    // Event type for order placed in DeepBook V3
    const eventType = `${config.sui.deepBookPackageId}::deepbook::OrderPlaced`;

    // queryEvents takes (eventType, limit) - limit defaults to 100
    const events = await suiService.queryEvents(eventType);

    if (events.data.length === 0) return;

    // Update cursor for pagination
    if (events.nextCursor) {
      this.lastCursor.set(subscription.poolKey, events.nextCursor.txDigest);
    }

    // Process events
    for (const event of events.data) {
      await this.processEvent(event, subscription);
    }
  }

  /**
   * Process a single event
   */
  private async processEvent(
    event: any,
    subscription: PoolSubscription,
  ): Promise<void> {
    try {
      const parsedEvent = event.parsedJson as DeepBookOrderEvent;

      // Check if this is from a tracked maker
      if (!subscription.trackedMakers.has(parsedEvent.maker)) {
        return;
      }

      // Check if it's for our tracked pool
      if (parsedEvent.poolId !== subscription.poolId) {
        return;
      }

      console.log(
        `New order from tracked maker ${parsedEvent.maker.slice(0, 10)}...`,
      );

      // Convert to MakerOrderEvent
      const makerOrderEvent: MakerOrderEvent = {
        makerAddress: parsedEvent.maker,
        poolKey: subscription.poolKey,
        orderId: parsedEvent.orderId,
        price: parseFloat(parsedEvent.price),
        quantity: parseFloat(parsedEvent.quantity),
        isBid: parsedEvent.isBid,
        timestamp: parseInt(parsedEvent.timestamp),
      };

      // Route to mirror engine
      await mirrorEngine.processMakerOrder(makerOrderEvent);
    } catch (error) {
      console.error("Error processing event:", error);
    }
  }

  /**
   * Handle order cancellation events
   */
  private async processOrderCancellation(
    event: any,
    subscription: PoolSubscription,
  ): Promise<void> {
    try {
      const parsedEvent = event.parsedJson as DeepBookOrderEvent;

      if (!subscription.trackedMakers.has(parsedEvent.maker)) {
        return;
      }

      console.log(
        `Order canceled by tracked maker ${parsedEvent.maker.slice(0, 10)}...`,
      );

      await mirrorEngine.processMakerOrderCancellation(
        parsedEvent.maker,
        subscription.poolKey,
        parsedEvent.orderId,
      );
    } catch (error) {
      console.error("Error processing cancellation:", error);
    }
  }

  /**
   * Get monitor status
   */
  getStatus(): {
    isRunning: boolean;
    subscribedPools: number;
    trackedMakers: number;
  } {
    let trackedMakers = 0;
    for (const sub of this.subscriptions.values()) {
      trackedMakers += sub.trackedMakers.size;
    }

    return {
      isRunning: this.isRunning,
      subscribedPools: this.subscriptions.size,
      trackedMakers,
    };
  }
}

// Singleton instance
export const eventMonitor = new EventMonitorService();
