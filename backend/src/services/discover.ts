/**
 * Discover Service
 *
 * Queries the DeepBook V3 Indexer REST API to find and rank
 * active liquidity providers (makers) on specific pools.
 *
 * Indexer docs: https://docs.sui.io/standards/deepbookv3-indexer
 * Endpoints used:
 *   GET /order_updates/:pool_name  — recent orders with balance_manager_id
 *   GET /trades/:pool_name         — recent trades with maker/taker info
 *   GET /get_pools                 — list all available pools
 *   GET /summary                   — 24h pool summaries
 *   GET /orderbook/:pool_name      — current order book
 */

import { config } from "../config/index.js";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface IndexerPool {
  pool_id: string;
  pool_name: string;
  base_asset_id: string;
  base_asset_decimals: number;
  base_asset_symbol: string;
  base_asset_name: string;
  quote_asset_id: string;
  quote_asset_decimals: number;
  quote_asset_symbol: string;
  quote_asset_name: string;
  min_size: number;
  lot_size: number;
  tick_size: number;
}

export interface PoolSummary {
  trading_pairs: string;
  base_currency: string;
  quote_currency: string;
  last_price: number;
  highest_bid: number;
  lowest_ask: number;
  base_volume: number;
  quote_volume: number;
  price_change_percent_24h: number;
  lowest_price_24h: number;
  highest_price_24h: number;
}

export interface IndexerOrder {
  order_id: string;
  balance_manager_id: string;
  timestamp: number;
  original_quantity: number;
  remaining_quantity: number;
  filled_quantity: number;
  price: number;
  status: string;
  type: string; // "buy" | "sell"
}

export interface OrderBookData {
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
}

export interface MakerProfile {
  balanceManagerId: string;
  orderCount: number;
  totalVolume: number;
  buyOrders: number;
  sellOrders: number;
  avgPrice: number;
  priceRange: { low: number; high: number };
  filledOrders: number;
  fillRate: number; // percentage
  lastActive: number; // timestamp
}

// ──────────────────────────────────────────────
//  Indexer Client
// ──────────────────────────────────────────────

function getBaseUrl(): string {
  const network = config.sui.network;
  return network === "mainnet"
    ? "https://deepbook-indexer.mainnet.mystenlabs.com"
    : "https://deepbook-indexer.testnet.mystenlabs.com";
}

async function fetchIndexer<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000), // 10s timeout
  });

  if (!response.ok) {
    throw new Error(
      `Indexer API error: ${response.status} ${response.statusText} for ${path}`,
    );
  }

  return response.json() as Promise<T>;
}

// ──────────────────────────────────────────────
//  Pool Discovery
// ──────────────────────────────────────────────

/**
 * Get all available pools from the indexer
 */
export async function getPools(): Promise<IndexerPool[]> {
  return fetchIndexer<IndexerPool[]>("/get_pools");
}

/**
 * Get 24h summary for all pools
 */
export async function getPoolSummaries(): Promise<PoolSummary[]> {
  return fetchIndexer<PoolSummary[]>("/summary");
}

/**
 * Get current order book for a pool
 */
export async function getOrderBook(
  poolName: string,
  depth: number = 10,
): Promise<OrderBookData> {
  return fetchIndexer<OrderBookData>(
    `/orderbook/${poolName}?level=2&depth=${depth}`,
  );
}

// ──────────────────────────────────────────────
//  Maker Discovery
// ──────────────────────────────────────────────

/**
 * Discover top makers on a specific pool
 *
 * Queries recent orders from the indexer, groups by balance_manager_id,
 * and ranks by total volume and order count.
 *
 * @param poolName - Pool name (e.g., "DEEP_SUI", "SUI_USDC")
 * @param limit - Max number of top makers to return
 * @param lookbackHours - How far back to look (default 24h)
 */
export async function discoverTopMakers(
  poolName: string,
  limit: number = 10,
  lookbackHours: number = 24,
): Promise<MakerProfile[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - lookbackHours * 3600;

  // Fetch recent placed orders from indexer
  const orders = await fetchIndexer<IndexerOrder[]>(
    `/order_updates/${poolName}?status=Placed&start_time=${startTime}&end_time=${now}&limit=500`,
  );

  if (!orders || orders.length === 0) {
    return [];
  }

  // Aggregate by balance_manager_id
  const makerMap = new Map<
    string,
    {
      orders: IndexerOrder[];
      totalVolume: number;
      buyCount: number;
      sellCount: number;
      filledCount: number;
      prices: number[];
      lastTimestamp: number;
    }
  >();

  for (const order of orders) {
    const bmId = order.balance_manager_id;
    if (!bmId) continue;

    let entry = makerMap.get(bmId);
    if (!entry) {
      entry = {
        orders: [],
        totalVolume: 0,
        buyCount: 0,
        sellCount: 0,
        filledCount: 0,
        prices: [],
        lastTimestamp: 0,
      };
      makerMap.set(bmId, entry);
    }

    entry.orders.push(order);
    entry.totalVolume += order.original_quantity;
    entry.prices.push(order.price);

    if (order.type === "buy") entry.buyCount++;
    else entry.sellCount++;

    if (order.filled_quantity > 0) entry.filledCount++;
    if (order.timestamp > entry.lastTimestamp)
      entry.lastTimestamp = order.timestamp;
  }

  // Build profiles and sort by volume
  const profiles: MakerProfile[] = [];

  for (const [bmId, data] of makerMap.entries()) {
    const orderCount = data.orders.length;
    const avgPrice =
      data.prices.length > 0
        ? data.prices.reduce((a, b) => a + b, 0) / data.prices.length
        : 0;

    profiles.push({
      balanceManagerId: bmId,
      orderCount,
      totalVolume: data.totalVolume,
      buyOrders: data.buyCount,
      sellOrders: data.sellCount,
      avgPrice,
      priceRange: {
        low: Math.min(...data.prices),
        high: Math.max(...data.prices),
      },
      filledOrders: data.filledCount,
      fillRate: orderCount > 0 ? (data.filledCount / orderCount) * 100 : 0,
      lastActive: data.lastTimestamp,
    });
  }

  // Sort by total volume (descending), then by order count
  profiles.sort((a, b) => {
    if (b.totalVolume !== a.totalVolume) return b.totalVolume - a.totalVolume;
    return b.orderCount - a.orderCount;
  });

  return profiles.slice(0, limit);
}

/**
 * Get a detailed pool overview: summary + top makers + order book snapshot
 */
export async function getPoolOverview(poolName: string): Promise<{
  summary: PoolSummary | null;
  topMakers: MakerProfile[];
  orderBookDepth: { bids: number; asks: number };
}> {
  const [summaries, topMakers, orderBook] = await Promise.all([
    getPoolSummaries().catch(() => []),
    discoverTopMakers(poolName, 5).catch(() => []),
    getOrderBook(poolName, 5).catch(() => ({ bids: [], asks: [] })),
  ]);

  const summary =
    summaries.find(
      (s) =>
        s.trading_pairs === poolName ||
        s.trading_pairs === poolName.replace("_", "/"),
    ) || null;

  return {
    summary,
    topMakers,
    orderBookDepth: {
      bids: orderBook.bids?.length || 0,
      asks: orderBook.asks?.length || 0,
    },
  };
}
