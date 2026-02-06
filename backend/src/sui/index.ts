/**
 * Sui Integration Layer
 *
 * Exports all Sui-related services
 */

// Sui Client (with DeepBook extension)
export { SuiService, suiService } from "./client.js";

// DeepBook V3 Service
export { DeepBookService, deepBookService } from "./deepbook.js";

// Mirror Contract Service
export {
  MirrorContractService,
  mirrorContractService,
  type MirrorPositionData,
  type MirrorCapabilityData,
  type ProtocolConfigData,
} from "./mirror.js";
