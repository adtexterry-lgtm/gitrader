// SPDX-License-Identifier: Apache-2.0
// 契约 §0.4 版本总表、§2.9 版本与兼容。

/** 契约文档版本（本包据此转写）。 */
export const CONTRACT_VERSION = '0.1.1'
/** 本包版本（v0.1.14：连接器查单与成交补回按标的定位）。 */
export const PROTOCOL_PACKAGE_VERSION = '0.1.14'
/** GEP 规范版本（§0.4：0.1.0）；协商只看 MAJOR.MINOR。 */
export const GEP_SPEC_VERSION = '0.1.0'
/** 本实现支持的、可在 gep.hello 里协商的版本（MAJOR.MINOR）。 */
export const GEP_SUPPORTED_VERSIONS: readonly string[] = ['0.1']
export const GEP_WS_SUBPROTOCOL = 'gep.v0'
export const GEP_WS_PATH = '/gep'
export const GEP_TOKEN_ENV = 'GITRADER_GEP_TOKEN'

export const GEP_LIMITS = {
  /** 单帧 ≤ 4 MiB（WS）。 */
  maxWsFrameBytes: 4 * 1024 * 1024,
  /** stdio 单行 ≤ 1 MiB。 */
  maxStdioLineBytes: 1024 * 1024,
  /** 心跳：双方每 ≤5 s 发一次。 */
  heartbeatIntervalMs: 5_000,
  /** 连续 3 个周期（15 s）收不到即判定断线。 */
  heartbeatTimeoutMs: 15_000,
  /** 确认：每 ≤1,000 条或 ≤1 s。 */
  ackEveryEvents: 1_000,
  ackEveryMs: 1_000,
  /** 未确认 >5,000 条时发送方可合并可合并流。 */
  backpressureUnackedEvents: 5_000,
  /** 保留窗：至少 max(10,000 条无损事件, 15 分钟)。 */
  retentionMinEvents: 10_000,
  retentionMinMs: 15 * 60 * 1000,
  /** engine.halt 的建议 ack 时限。 */
  haltAckMs: 200,
  /** history 单次最多 5000 根。 */
  maxHistoryLimit: 5_000,
} as const

/** "0.1.0" → "0.1"；不是 MAJOR.MINOR[.PATCH] 返回 null。 */
export function majorMinor(version: string): string | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version)
  return m ? `${m[1]}.${m[2]}` : null
}

function cmpMajorMinor(a: string, b: string): number {
  const [a1, a2] = a.split('.').map(Number) as [number, number]
  const [b1, b2] = b.split('.').map(Number) as [number, number]
  return a1 - b1 || a2 - b2
}

/**
 * 版本协商（§2.9）：从对方提供的版本里选出双方都支持的最高 MAJOR.MINOR；没有交集返回 null，
 * 调用方应回错误 5001 VERSION_UNSUPPORTED。
 */
export function negotiateVersion(offered: readonly string[], supported: readonly string[] = GEP_SUPPORTED_VERSIONS): string | null {
  const have = new Set(supported.map(majorMinor).filter((v): v is string => v !== null))
  const common = offered.map(majorMinor).filter((v): v is string => v !== null && have.has(v))
  if (common.length === 0) return null
  return common.sort(cmpMajorMinor).at(-1) ?? null
}
