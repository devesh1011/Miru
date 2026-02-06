/**
 * Error Handling Utilities
 *
 * Centralized error parsing and user-friendly message generation
 * for Sui RPC errors, zkLogin errors, and general failures.
 */

// ──────────────────────────────────────────────
//  Error Categories
// ──────────────────────────────────────────────

export enum ErrorCategory {
  INSUFFICIENT_GAS = "INSUFFICIENT_GAS",
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  SESSION_EXPIRED = "SESSION_EXPIRED",
  SESSION_MISSING = "SESSION_MISSING",
  OBJECT_NOT_FOUND = "OBJECT_NOT_FOUND",
  CONTRACT_ERROR = "CONTRACT_ERROR",
  RPC_ERROR = "RPC_ERROR",
  NETWORK_ERROR = "NETWORK_ERROR",
  PROVER_ERROR = "PROVER_ERROR",
  INVALID_INPUT = "INVALID_INPUT",
  RATE_LIMITED = "RATE_LIMITED",
  TIMEOUT = "TIMEOUT",
  UNKNOWN = "UNKNOWN",
}

export interface ParsedError {
  category: ErrorCategory;
  userMessage: string;
  technicalMessage: string;
  suggestion?: string;
}

// ──────────────────────────────────────────────
//  Sui / RPC Error Parsing
// ──────────────────────────────────────────────

const SUI_ERROR_PATTERNS: {
  pattern: RegExp;
  category: ErrorCategory;
  userMessage: string;
  suggestion: string;
}[] = [
  {
    pattern:
      /insufficient.*balance|InsufficientCoinBalance|not enough.*gas|GasBalanceTooLow|No valid gas coins/i,
    category: ErrorCategory.INSUFFICIENT_GAS,
    userMessage: "Your wallet doesn't have enough SUI for gas fees.",
    suggestion:
      "Fund your wallet with SUI first. Use /deposit to see your address, then send SUI from a faucet or another wallet.",
  },
  {
    pattern: /InsufficientGas|GasBudgetTooHigh|gas budget.*exceeds/i,
    category: ErrorCategory.INSUFFICIENT_GAS,
    userMessage: "Transaction gas budget issue.",
    suggestion:
      "Your wallet may need more SUI. Use /deposit to check your balance and fund it.",
  },
  {
    pattern: /ObjectNotFound|object.*not found|unable to find object/i,
    category: ErrorCategory.OBJECT_NOT_FOUND,
    userMessage: "A required on-chain object was not found.",
    suggestion:
      "The position or capability may have been deleted. Check /positions for current state.",
  },
  {
    pattern: /MoveAbort|abort.*code|VMVerification|function.*not found/i,
    category: ErrorCategory.CONTRACT_ERROR,
    userMessage: "Smart contract execution failed.",
    suggestion:
      "This may be a permissions issue. Make sure you own the position and have an active capability.",
  },
  {
    pattern:
      /ENotOwner|ENotOperator|ECapabilityExpired|EPositionNotActive|ECapabilityNotActive/i,
    category: ErrorCategory.CONTRACT_ERROR,
    userMessage: "Permission denied by the smart contract.",
    suggestion:
      "You may not own this position, or the bot's capability has expired. Try /grant to refresh permissions.",
  },
  {
    pattern: /ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i,
    category: ErrorCategory.NETWORK_ERROR,
    userMessage: "Network connection error.",
    suggestion:
      "The Sui RPC node may be temporarily unavailable. Please try again in a few seconds.",
  },
  {
    pattern: /429|too many requests|rate.?limit/i,
    category: ErrorCategory.RATE_LIMITED,
    userMessage: "Rate limited by the network.",
    suggestion: "Too many requests. Please wait a moment and try again.",
  },
  {
    pattern: /timeout|timed out|deadline exceeded/i,
    category: ErrorCategory.TIMEOUT,
    userMessage: "Request timed out.",
    suggestion:
      "The network is slow. Please try again. If this persists, the RPC node may be under heavy load.",
  },
  {
    pattern:
      /invalid.*transaction|transaction.*failed|effects.*status.*failure/i,
    category: ErrorCategory.CONTRACT_ERROR,
    userMessage: "Transaction execution failed on-chain.",
    suggestion: "Check that all parameters are correct and try again.",
  },
];

/**
 * Parse a Sui/RPC error into a user-friendly message.
 */
export function parseSuiError(error: unknown): ParsedError {
  const rawMessage = extractErrorMessage(error);

  for (const {
    pattern,
    category,
    userMessage,
    suggestion,
  } of SUI_ERROR_PATTERNS) {
    if (pattern.test(rawMessage)) {
      return {
        category,
        userMessage,
        technicalMessage: rawMessage,
        suggestion,
      };
    }
  }

  return {
    category: ErrorCategory.UNKNOWN,
    userMessage: "An unexpected error occurred.",
    technicalMessage: rawMessage,
    suggestion: "Please try again. If the problem persists, check /status.",
  };
}

// ──────────────────────────────────────────────
//  zkLogin Error Parsing
// ──────────────────────────────────────────────

const ZKLOGIN_ERROR_PATTERNS: {
  pattern: RegExp;
  category: ErrorCategory;
  userMessage: string;
  suggestion: string;
}[] = [
  {
    pattern: /session.*not.*complete|no.*active.*session|Please.*\/connect/i,
    category: ErrorCategory.SESSION_MISSING,
    userMessage: "No active zkLogin session found.",
    suggestion: "Use /connect to sign in with Google first.",
  },
  {
    pattern: /session.*expired|epoch.*exceeded|max_epoch/i,
    category: ErrorCategory.SESSION_EXPIRED,
    userMessage: "Your zkLogin session has expired.",
    suggestion:
      "Sessions last a few epochs (~24h). Use /connect to re-authenticate.",
  },
  {
    pattern: /nonce.*mismatch|invalid.*nonce/i,
    category: ErrorCategory.PROVER_ERROR,
    userMessage: "Authentication token mismatch.",
    suggestion:
      "Start a fresh session with /connect and complete the sign-in again.",
  },
  {
    pattern: /audience.*not.*supported|invalid.*aud/i,
    category: ErrorCategory.PROVER_ERROR,
    userMessage: "OAuth client ID not accepted by the ZK prover.",
    suggestion: "This is a configuration issue. Please contact support.",
  },
  {
    pattern: /Invalid JWT|JWT.*missing|malformed.*jwt/i,
    category: ErrorCategory.INVALID_INPUT,
    userMessage: "Invalid authentication token.",
    suggestion:
      "Make sure you copied the complete JWT from the callback page. Use /connect to start over.",
  },
  {
    pattern: /ZK Prover error/i,
    category: ErrorCategory.PROVER_ERROR,
    userMessage: "The ZK proof service returned an error.",
    suggestion:
      "The prover may be temporarily unavailable. Wait a minute and try /connect again.",
  },
  {
    pattern: /wrong.*secretkey.*size|keypair.*failed|deserialize.*keypair/i,
    category: ErrorCategory.SESSION_MISSING,
    userMessage: "Session data is corrupted.",
    suggestion:
      "Use /connect to create a fresh session. Your funds are safe — the address is derived from your Google identity.",
  },
  {
    pattern:
      /Groth16.*proof.*verify.*failed|Invalid user signature.*Signature is not valid/i,
    category: ErrorCategory.SESSION_EXPIRED,
    userMessage: "Your zkLogin proof is invalid or has expired.",
    suggestion:
      "Your authentication session is stale. Use /connect to re-authenticate with Google, then try again.",
  },
];

/**
 * Parse a zkLogin-specific error into a user-friendly message.
 */
export function parseZkLoginError(error: unknown): ParsedError {
  const rawMessage = extractErrorMessage(error);

  for (const {
    pattern,
    category,
    userMessage,
    suggestion,
  } of ZKLOGIN_ERROR_PATTERNS) {
    if (pattern.test(rawMessage)) {
      return {
        category,
        userMessage,
        technicalMessage: rawMessage,
        suggestion,
      };
    }
  }

  // Fall back to general Sui error parsing
  return parseSuiError(error);
}

// ──────────────────────────────────────────────
//  Formatting
// ──────────────────────────────────────────────

/**
 * Format a ParsedError for display in Telegram.
 */
export function formatErrorForUser(parsed: ParsedError): string {
  let msg = `❌ ${parsed.userMessage}`;
  if (parsed.suggestion) {
    msg += `\n\n💡 ${parsed.suggestion}`;
  }
  return msg;
}

/**
 * Format a ParsedError with technical details (for debugging).
 */
export function formatErrorVerbose(parsed: ParsedError): string {
  let msg = formatErrorForUser(parsed);
  if (parsed.technicalMessage && parsed.technicalMessage.length < 200) {
    msg += `\n\n🔧 Details: ${parsed.technicalMessage}`;
  }
  return msg;
}

// ──────────────────────────────────────────────
//  Balance Check
// ──────────────────────────────────────────────

/** Minimum SUI balance (in MIST) needed for a transaction (~0.05 SUI) */
export const MIN_GAS_BALANCE_MIST = 50_000_000; // 0.05 SUI

/**
 * Check if balance is sufficient for gas.
 * Returns null if OK, or a user-friendly error message if insufficient.
 */
export function checkGasBalance(
  balanceMist: bigint | number | string,
  label: string = "your wallet",
): string | null {
  const balance =
    typeof balanceMist === "bigint"
      ? balanceMist
      : BigInt(balanceMist.toString());
  if (balance < BigInt(MIN_GAS_BALANCE_MIST)) {
    const suiAmount = Number(balance) / 1_000_000_000;
    const minSui = MIN_GAS_BALANCE_MIST / 1_000_000_000;
    return (
      `⚠️ ${label} has insufficient SUI for gas fees.\n\n` +
      `Current balance: ${suiAmount.toFixed(4)} SUI\n` +
      `Minimum needed: ~${minSui} SUI\n\n` +
      `💡 Use /deposit to see your address and fund it from a faucet or another wallet.`
    );
  }
  return null;
}

/**
 * Check if balance is sufficient for a withdrawal.
 * Accounts for gas overhead.
 */
export function checkWithdrawBalance(
  balanceMist: bigint | number | string,
  amountMist: number,
): string | null {
  const balance =
    typeof balanceMist === "bigint"
      ? balanceMist
      : BigInt(balanceMist.toString());
  const needed = BigInt(amountMist) + BigInt(MIN_GAS_BALANCE_MIST);
  if (balance < needed) {
    const suiBalance = Number(balance) / 1_000_000_000;
    const suiAmount = amountMist / 1_000_000_000;
    const suiNeeded = Number(needed) / 1_000_000_000;
    return (
      `⚠️ Insufficient balance for this withdrawal.\n\n` +
      `Requested: ${suiAmount.toFixed(4)} SUI\n` +
      `Gas reserve: ~${(MIN_GAS_BALANCE_MIST / 1_000_000_000).toFixed(4)} SUI\n` +
      `Total needed: ~${suiNeeded.toFixed(4)} SUI\n` +
      `Available: ${suiBalance.toFixed(4)} SUI\n\n` +
      `💡 Reduce the amount or deposit more SUI first.`
    );
  }
  return null;
}

// ──────────────────────────────────────────────
//  Validation Helpers
// ──────────────────────────────────────────────

/**
 * Validate a Sui address format.
 * Returns null if valid, or an error message string.
 */
export function validateSuiAddress(address: string): string | null {
  if (!address) return "Address is required.";
  if (!address.startsWith("0x")) return "Sui address must start with 0x.";
  if (address.length < 10) return "Address is too short.";
  if (address.length > 66)
    return "Address is too long. Sui addresses are 66 characters (0x + 64 hex).";
  if (!/^0x[0-9a-fA-F]+$/.test(address))
    return "Address contains invalid characters. Only hex characters (0-9, a-f) are allowed.";
  return null;
}

/**
 * Validate ratio parameter.
 * Returns null if valid, or an error message string.
 */
export function validateRatio(ratioStr: string): string | null {
  const ratio = parseInt(ratioStr, 10);
  if (isNaN(ratio)) return "Ratio must be a number.";
  if (ratio < 1) return "Ratio must be at least 1%.";
  if (ratio > 100) return "Ratio cannot exceed 100%.";
  return null;
}

// ──────────────────────────────────────────────
//  Utility
// ──────────────────────────────────────────────

/**
 * Safely extract an error message from any thrown value.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Some Sui errors nest the real message
    const cause = (error as any).cause;
    if (cause instanceof Error) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    // Handle RPC error objects
    const obj = error as Record<string, any>;
    if (obj.message) return String(obj.message);
    if (obj.error) return String(obj.error);
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error (unserializable)";
    }
  }
  return "Unknown error";
}

/**
 * Wrap an async operation with a timeout.
 * Throws if the timeout is exceeded.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string = "Operation",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Retry an async operation with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryOn?: (error: unknown) => boolean;
    label?: string;
  } = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    retryOn = isRetryableError,
    label = "Operation",
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !retryOn(error)) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      console.warn(
        `${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`,
        extractErrorMessage(error),
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Check if an error is retryable (network/timeout issues).
 */
export function isRetryableError(error: unknown): boolean {
  const msg = extractErrorMessage(error);
  return /ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|timeout|timed out|429|rate.?limit|503|502/i.test(
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
