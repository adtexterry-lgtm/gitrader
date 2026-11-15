// SPDX-License-Identifier: CPAL-1.0
// 内存缓存：TTL 过期 + LRU 淘汰 + 命中统计。
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/data_sources/cache_manager.py:42-190; adapted.
// 与 QD 的 DataCache 一致：get 过期即删并记 miss；命中刷新 LRU 顺序；set 超容量淘汰最久未用；stats 给命中率。
// 差异（按本仓库约定）：同步实现（Node 单线程，不需要锁），键固定为 string，时间由可注入的 clock 提供（测试用假时钟）。

export interface TtlLruCacheStats {
  size: number
  hits: number
  misses: number
  evictions: number
  expirations: number
  hitRatio: number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class TtlLruCache<V> {
  private readonly maxEntries: number
  private readonly defaultTtlMs: number
  private readonly clock: () => number
  /** Map 的插入顺序就是 LRU 顺序：最旧的在前（对应 QD 的 OrderedDict）。 */
  private readonly entries = new Map<string, Entry<V>>()
  private hits = 0
  private misses = 0
  private evictions = 0
  private expirations = 0

  constructor(opts: { maxEntries: number; defaultTtlMs: number; clock?: () => number }) {
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries))
    this.defaultTtlMs = opts.defaultTtlMs
    this.clock = opts.clock ?? (() => Date.now())
  }

  /** 过期 → 删除并记 miss；命中 → 刷新 LRU 顺序。 */
  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    if (this.clock() >= entry.expiresAt) {
      this.entries.delete(key)
      this.expirations++
      this.misses++
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    return entry.value
  }

  /** 写入；超 maxEntries → 淘汰最久未用（与 QD 一样先腾位置再写入）。 */
  set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs
    const existed = this.entries.delete(key) // 覆盖已有键：位置刷新到最新，不占新容量
    if (!existed) {
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next()
        if (oldest.done === true) break
        this.entries.delete(oldest.value)
        this.evictions++
      }
    }
    this.entries.set(key, { value, expiresAt: this.clock() + ttl })
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  stats(): TtlLruCacheStats {
    const total = this.hits + this.misses
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      hitRatio: total > 0 ? this.hits / total : 0,
    }
  }
}
