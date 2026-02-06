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
  status: 'pending' | 'confirmed' | 'failed';
}
