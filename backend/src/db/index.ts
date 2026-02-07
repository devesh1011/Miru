/**
 * Database module barrel export
 */

export { getDb, initializeDatabase, closeDatabase } from "./schema.js";
export {
  userRepo,
  positionRepo,
  orderRepo,
  capabilityRepo,
  type DbUser,
  type DbPosition,
  type DbOrder,
  type DbCapability,
} from "./repository.js";
export {
  analyticsRepo,
  riskSettingsRepo,
  notificationPrefsRepo,
  dailyTradeRepo,
  type DbPositionAnalytics,
  type DbRiskSettings,
  type DbNotificationPreferences,
  type DbDailyTradeCount,
} from "./analytics-repository.js";
