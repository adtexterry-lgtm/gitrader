// SPDX-License-Identifier: Apache-2.0
/**
 * Release gate: 0.1.0 mainnet live trading lock.
 * All judgments MUST import this constant; no hardcoded checks elsewhere.
 */
export const MAINNET_LIVE_ENABLED = false

/**
 * Checks if an account is blocked by the 0.1.0 mainnet live gate.
 * @returns true if blocked (mainnet live and gate is closed)
 */
export function mainnetLiveBlocked(account: { mode: string; environment: string }): boolean {
  return account.mode === 'live' && account.environment === 'mainnet' && !MAINNET_LIVE_ENABLED
}
