// SPDX-License-Identifier: Apache-2.0

/** Per-principal budget for authenticated operations. */
export interface OperationRateLimitConfig {
  /** Maximum operation tokens held by one principal. */
  capacity?: number
  /** Tokens replenished per second. */
  refillPerSecond?: number
  /** Optional bucket dedicated to browser sessions; defaults to a larger capacity than other principals. */
  session?: { capacity?: number; refillPerSecond?: number }
}

/** Optional local server security settings. */
export interface ServerSecurityConfig {
  operationRateLimit?: OperationRateLimitConfig
  maxWsSubscriptions?: number
}
