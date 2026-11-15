// SPDX-License-Identifier: CPAL-1.0
/** 内核重启探测（UI 侧）：/api/health 的 startedAt 在本页会话内变了 = 内核重启过。只在内存里比较，不写盘、不写内核。 */
export function createRestartWatcher(read: () => Promise<number | null>, onRestart: (startedAt: number) => void): () => Promise<void> {
  let seen: number | null = null
  return async () => {
    let now: number | null = null
    try { now = await read() } catch { now = null }
    if (typeof now !== 'number' || !Number.isFinite(now)) return // 读不到（含内核重启中的瞬间）不当作变化，等下一轮
    if (seen !== null && now !== seen) onRestart(now)
    seen = now
  }
}

/** 读 /api/health（免令牌存活探针）里的 startedAt。 */
export async function readStartedAt(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const res = await fetchImpl('/api/health', { cache: 'no-store' })
  if (!res.ok) return null
  const body = (await res.json()) as { startedAt?: unknown }
  return typeof body.startedAt === 'number' ? body.startedAt : null
}
