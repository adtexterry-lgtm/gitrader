// SPDX-License-Identifier: CPAL-1.0
// 只读观察账户（R3-20）：按公开地址读场所的公开账户状态，不需要任何钥匙，只能看、不能动。
// 本目录只放"读"：地址校验、判断是不是观察账户、交易侧看到的空快照、按地址读公开状态的读取器。
export const WATCH_MODE = 'watch' as const
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** 0x 加 40 位十六进制。 */
export const isWatchAddress = (v: unknown): boolean => typeof v === 'string' && ADDRESS.test(v)

/** 观察账户的 mode 是内核本地的 'watch'（协议的 AccountMode 里没有，协议不归本包改）。 */
export const isWatchAccount = (a: { mode: string }): boolean => a.mode === WATCH_MODE

export { WatchReader } from './reader'
export type { WatchSource, WatchSourceFactory } from './reader'
export { emptyWatchSnapshot, emptyWatchStartup } from './empty'
