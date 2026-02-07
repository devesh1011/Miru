export interface MirrorPosition {
  id: string;
  userId: string;
  makerAddress: string;
  poolId: string;
  ratio: number; // 1-100
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MakerOrder {
  orderId: string;
  makerAddress: string;
  poolId: string;
  price: string;
  quantity: string;
  isBid: boolean;
  timestamp: number;
}

export interface UserBalance {
  userId: string;
  balanceManagerId: string;
  asset: string;
  amount: string;
}

export interface PoolInfo {
  poolId: string;
  baseAsset: string;
  quoteAsset: string;
  baseName: string;
  quoteName: string;
}

export interface OrderBookLevel {
  price: string;
  quantity: string;
}

export interface OrderBookData {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPrice: string;
  timestamp: number;
}

export interface TradeExecution {
  userId: string;
  positionId: string;
  orderId: string;
  poolId: string;
  price: string;
  quantity: string;
  isBid: boolean;
  txDigest: string;
  timestamp: number;
  status: "pending" | "confirmed" | "failed";
}

// ──────────────────────────────────────────────
//  Position Analytics Types
// ──────────────────────────────────────────────

export interface PositionAnalytics {
  positionId: string;
  totalPnl: number;
  totalPnlPercent: number;
  totalVolume: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgOrderSize: number;
  duration: number; // ms since position creation
  lastUpdated: number;
}

export interface OrderAnalytics {
  orderId: number;
  positionId: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  isBid: boolean;
  status: string;
  timestamp: number;
}

export interface PortfolioSummary {
  totalValue: number;
  totalPnl: number;
  totalPnlPercent: number;
  activePositions: number;
  totalOrders: number;
  topPerformer: { poolKey: string; pnl: number } | null;
  worstPerformer: { poolKey: string; pnl: number } | null;
}

// ──────────────────────────────────────────────
//  Risk Management Types
// ──────────────────────────────────────────────

export interface RiskSettings {
  userId: string;
  positionId?: string; // null = global defaults
  maxOrderSize: number; // max SUI per order
  stopLossPercent: number; // auto-pause if P&L < -X%
  takeProfitPercent: number; // notify at +X%
  dailyTradeLimit: number; // max orders per day
  maxOpenPositions: number; // max concurrent positions
  autoPauseOnLoss: boolean; // auto-pause maker if ROI < 0%
  minBalanceThreshold: number; // pause all if SUI balance < X
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  userId: "",
  maxOrderSize: 100,
  stopLossPercent: 15,
  takeProfitPercent: 30,
  dailyTradeLimit: 50,
  maxOpenPositions: 10,
  autoPauseOnLoss: false,
  minBalanceThreshold: 0.5,
};

// ──────────────────────────────────────────────
//  Smart Notification Types
// ──────────────────────────────────────────────

export type NotificationType =
  | "order_executed"
  | "position_created"
  | "position_stopped"
  | "pnl_update"
  | "stop_loss_triggered"
  | "take_profit_hit"
  | "balance_low"
  | "daily_summary"
  | "maker_performance_alert"
  | "risk_limit_reached";

export interface NotificationPreferences {
  userId: string;
  orderExecuted: boolean;
  positionCreated: boolean;
  positionStopped: boolean;
  pnlUpdates: boolean;
  stopLossAlerts: boolean;
  takeProfitAlerts: boolean;
  balanceLowAlerts: boolean;
  dailySummary: boolean;
  makerPerformanceAlerts: boolean;
  riskLimitAlerts: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPreferences = {
  userId: "",
  orderExecuted: true,
  positionCreated: true,
  positionStopped: true,
  pnlUpdates: false,
  stopLossAlerts: true,
  takeProfitAlerts: true,
  balanceLowAlerts: true,
  dailySummary: false,
  makerPerformanceAlerts: true,
  riskLimitAlerts: true,
};
