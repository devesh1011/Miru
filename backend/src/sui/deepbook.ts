import { Transaction } from "@mysten/sui/transactions";
import {
  type PlaceLimitOrderParams,
  type PlaceMarketOrderParams,
  OrderType,
  SelfMatchingOptions,
} from "@mysten/deepbook-v3";
import { suiService } from "./client.js";
import type { OrderBookData, OrderBookLevel } from "../types/index.js";

/**
 * DeepBook V3 Integration Service
 *
 * Uses the official @mysten/deepbook-v3 SDK.
 * All trading operations go through:
 *   suiService.getDeepBook().deepBook   (DeepBookContract - transactions)
 *   suiService.getDeepBook().balanceManager (BalanceManagerContract - transactions)
 *   suiService.getDeepBook().<readMethod>  (read-only queries)
 */
export class DeepBookService {
  // ──────────────────────────────────────────────
  //  Balance Manager Operations
  // ──────────────────────────────────────────────

  /**
   * Create and share a new BalanceManager
   */
  async createBalanceManager(): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    db.balanceManager.createAndShareBalanceManager()(tx);

    const txResult = await suiService.executeTransactionFull(tx);

    // Find the created BalanceManager from effects
    const objectTypes = txResult.objectTypes ?? {};
    const effects = txResult.effects;
    const createdObjects =
      effects?.changedObjects?.filter(
        (obj: any) => obj.idOperation === "Created",
      ) || [];

    const balanceManagerObj = createdObjects.find((obj: any) => {
      const objType = objectTypes[obj.objectId];
      return objType && objType.includes("BalanceManager");
    });

    if (!balanceManagerObj) {
      throw new Error("BalanceManager not found in transaction result");
    }

    return (balanceManagerObj as any).objectId;
  }

  /**
   * Deposit funds into a BalanceManager
   * @param managerKey - Key name registered with the SDK (e.g. "MANAGER_1")
   * @param coinKey - Coin key (e.g. "SUI", "DEEP", "DBUSDC")
   * @param amount - Amount as a number (SDK handles scaling)
   */
  async deposit(
    managerKey: string,
    coinKey: string,
    amount: number,
  ): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    db.balanceManager.depositIntoManager(managerKey, coinKey, amount)(tx);

    return suiService.executeTransaction(tx);
  }

  /**
   * Withdraw funds from a BalanceManager
   */
  async withdraw(
    managerKey: string,
    coinKey: string,
    amount: number,
    recipient?: string,
  ): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();
    const recipientAddress = recipient || suiService.getAddress();

    db.balanceManager.withdrawFromManager(
      managerKey,
      coinKey,
      amount,
      recipientAddress,
    )(tx);

    return suiService.executeTransaction(tx);
  }

  // ──────────────────────────────────────────────
  //  Trading Operations
  // ──────────────────────────────────────────────

  /**
   * Place a limit order on DeepBook
   *
   * SDK PlaceLimitOrderParams: { poolKey, balanceManagerKey, clientOrderId: string,
   *   price, quantity, isBid, expiration?, orderType?, selfMatchingOption?, payWithDeep? }
   */
  async placeLimitOrder(params: {
    poolKey: string;
    managerKey: string;
    price: number;
    quantity: number;
    isBid: boolean;
    clientOrderId?: number | string;
    expiration?: number;
    orderType?: OrderType;
    selfMatchingOption?: SelfMatchingOptions;
    payWithDeep?: boolean;
  }): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    const sdkParams: PlaceLimitOrderParams = {
      poolKey: params.poolKey,
      balanceManagerKey: params.managerKey,
      clientOrderId:
        params.clientOrderId !== undefined
          ? String(params.clientOrderId)
          : String(Date.now()),
      price: params.price,
      quantity: params.quantity,
      isBid: params.isBid,
      expiration: params.expiration,
      orderType: params.orderType ?? OrderType.NO_RESTRICTION,
      selfMatchingOption:
        params.selfMatchingOption ?? SelfMatchingOptions.SELF_MATCHING_ALLOWED,
      payWithDeep: params.payWithDeep ?? true,
    };

    db.deepBook.placeLimitOrder(sdkParams)(tx);

    return suiService.executeTransaction(tx);
  }

  /**
   * Place a market order on DeepBook
   */
  async placeMarketOrder(params: {
    poolKey: string;
    managerKey: string;
    quantity: number;
    isBid: boolean;
    clientOrderId?: number | string;
    selfMatchingOption?: SelfMatchingOptions;
    payWithDeep?: boolean;
  }): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    const sdkParams: PlaceMarketOrderParams = {
      poolKey: params.poolKey,
      balanceManagerKey: params.managerKey,
      clientOrderId:
        params.clientOrderId !== undefined
          ? String(params.clientOrderId)
          : String(Date.now()),
      quantity: params.quantity,
      isBid: params.isBid,
      selfMatchingOption:
        params.selfMatchingOption ?? SelfMatchingOptions.SELF_MATCHING_ALLOWED,
      payWithDeep: params.payWithDeep ?? true,
    };

    db.deepBook.placeMarketOrder(sdkParams)(tx);

    return suiService.executeTransaction(tx);
  }

  /**
   * Cancel an order
   */
  async cancelOrder(params: {
    poolKey: string;
    managerKey: string;
    orderId: string;
  }): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    db.deepBook.cancelOrder(
      params.poolKey,
      params.managerKey,
      params.orderId,
    )(tx);

    return suiService.executeTransaction(tx);
  }

  /**
   * Cancel all open orders for a balance manager in a pool
   */
  async cancelAllOrders(poolKey: string, managerKey: string): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    db.deepBook.cancelAllOrders(poolKey, managerKey)(tx);

    return suiService.executeTransaction(tx);
  }

  // ──────────────────────────────────────────────
  //  Read Operations (no transactions needed)
  // ──────────────────────────────────────────────

  /**
   * Get mid price for a pool
   */
  async getMidPrice(poolKey: string): Promise<number> {
    const db = suiService.getDeepBook();
    return db.midPrice(poolKey);
  }

  /**
   * Get Level 2 order book data within a price range
   */
  async getOrderBook(
    poolKey: string,
    priceLow: number,
    priceHigh: number,
  ): Promise<OrderBookData> {
    const db = suiService.getDeepBook();

    const [bidsData, asksData, midPrice] = await Promise.all([
      db.getLevel2Range(poolKey, priceLow, priceHigh, true),
      db.getLevel2Range(poolKey, priceLow, priceHigh, false),
      db.midPrice(poolKey),
    ]);

    const toBookLevels = (data: {
      prices: number[];
      quantities: number[];
    }): OrderBookLevel[] =>
      data.prices.map((price, i) => ({
        price: price.toString(),
        quantity: data.quantities[i].toString(),
      }));

    return {
      bids: toBookLevels(bidsData),
      asks: toBookLevels(asksData),
      midPrice: midPrice.toString(),
      timestamp: Date.now(),
    };
  }

  /**
   * Get Level 2 order book ticks from mid-price
   */
  async getLevel2TicksFromMid(
    poolKey: string,
    ticks: number,
  ): Promise<{
    bid_prices: number[];
    bid_quantities: number[];
    ask_prices: number[];
    ask_quantities: number[];
  }> {
    const db = suiService.getDeepBook();
    return db.getLevel2TicksFromMid(poolKey, ticks);
  }

  /**
   * Get account open orders
   */
  async getOpenOrders(poolKey: string, managerKey: string): Promise<string[]> {
    const db = suiService.getDeepBook();
    return db.accountOpenOrders(poolKey, managerKey);
  }

  /**
   * Get detailed order info
   */
  async getOrder(poolKey: string, orderId: string) {
    const db = suiService.getDeepBook();
    return db.getOrder(poolKey, orderId);
  }

  /**
   * Get detailed order info for multiple orders
   */
  async getOrders(poolKey: string, orderIds: string[]) {
    const db = suiService.getDeepBook();
    return db.getOrders(poolKey, orderIds);
  }

  /**
   * Get account order details for a balance manager
   */
  async getAccountOrderDetails(poolKey: string, managerKey: string) {
    const db = suiService.getDeepBook();
    return db.getAccountOrderDetails(poolKey, managerKey);
  }

  /**
   * Check balance manager balance for a coin
   */
  async getManagerBalance(
    managerKey: string,
    coinKey: string,
  ): Promise<{ coinType: string; balance: number }> {
    const db = suiService.getDeepBook();
    return db.checkManagerBalance(managerKey, coinKey);
  }

  /**
   * Get pool trade parameters (taker/maker fees, stake required)
   */
  async getPoolTradeParams(
    poolKey: string,
  ): Promise<{ takerFee: number; makerFee: number; stakeRequired: number }> {
    const db = suiService.getDeepBook();
    return db.poolTradeParams(poolKey);
  }

  /**
   * Get pool book parameters (tick size, lot size, min size)
   */
  async getPoolBookParams(
    poolKey: string,
  ): Promise<{ tickSize: number; lotSize: number; minSize: number }> {
    const db = suiService.getDeepBook();
    return db.poolBookParams(poolKey);
  }

  /**
   * Get pool vault balances
   */
  async getVaultBalances(
    poolKey: string,
  ): Promise<{ base: number; quote: number; deep: number }> {
    const db = suiService.getDeepBook();
    return db.vaultBalances(poolKey);
  }

  /**
   * Get pool ID from pool key
   */
  async getPoolId(poolKey: string): Promise<string> {
    const db = suiService.getDeepBook();
    return db.poolId(poolKey);
  }

  /**
   * Get pool ID by asset types
   */
  async getPoolIdByAssets(
    baseType: string,
    quoteType: string,
  ): Promise<string> {
    const db = suiService.getDeepBook();
    return db.getPoolIdByAssets(baseType, quoteType);
  }

  /**
   * Get account info for a balance manager in a pool
   */
  async getAccount(poolKey: string, managerKey: string) {
    const db = suiService.getDeepBook();
    return db.account(poolKey, managerKey);
  }

  /**
   * Get locked balances for a balance manager in a pool
   */
  async getLockedBalance(
    poolKey: string,
    managerKey: string,
  ): Promise<{ base: number; quote: number; deep: number }> {
    const db = suiService.getDeepBook();
    return db.lockedBalance(poolKey, managerKey);
  }

  /**
   * Withdraw settled amounts from a pool
   */
  async withdrawSettledAmounts(
    poolKey: string,
    managerKey: string,
  ): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    db.deepBook.withdrawSettledAmounts(poolKey, managerKey)(tx);

    return suiService.executeTransaction(tx);
  }

  /**
   * Claim rebates for a balance manager
   */
  async claimRebates(poolKey: string, managerKey: string): Promise<string> {
    const tx = new Transaction();
    const db = suiService.getDeepBook();

    db.deepBook.claimRebates(poolKey, managerKey)(tx);

    return suiService.executeTransaction(tx);
  }
}

// Singleton instance
export const deepBookService = new DeepBookService();
