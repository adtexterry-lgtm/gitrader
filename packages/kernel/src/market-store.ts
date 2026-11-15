// SPDX-License-Identifier: CPAL-1.0
// 本地 K 线库：每个 (instrumentId, interval) 一个 JSONL 文件，只追加；读时按 t 去重（后写覆盖先写）、升序。
// R1-PERF-03：文件布局和行格式不变；旁挂一份内存索引（t → 行的字节偏移），区间读只读命中的行，不再每次整文件读入解析；
// 写入对「已有内容」去重：与已有行完全相同的根不再落盘（重启后、并发补同一缺口都一样），值不同的当修订照旧追加（读时后写覆盖）。
// 老文件里已有的重复行照常读出（同 t 取最后一行），不要求先压实。
import { appendFile, mkdir, open, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { BigIntStats, Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Candle } from '@gitrader/protocol'
import type { EventBus, KernelEvent, Unsubscribe } from './events'
import { writeFileAtomic } from './util/fsperm'

export interface StoreReadOpts { from?: number; to?: number; n?: number }

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_')
// Windows 文件名不分大小写：1M（月）与 1m（分）会撞同一文件，月线落盘用 1mo。
const fileInterval = (iv: string): string => (iv === '1M' ? '1mo' : iv)
const fromFileInterval = (s: string): string => (s === '1mo' ? '1M' : s)

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** 解析一行 / 一个对象为 Candle；t/o/h/l/c 必须有限，v 缺省 0。 */
function toCandle(raw: unknown): Candle | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (!isFiniteNum(o.t) || !isFiniteNum(o.o) || !isFiniteNum(o.h) || !isFiniteNum(o.l) || !isFiniteNum(o.c)) return undefined
  return { t: o.t, o: o.o, h: o.h, l: o.l, c: o.c, v: isFiniteNum(o.v) ? o.v : 0 }
}

const lineOf = (c: Candle): string => JSON.stringify({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }) + '\n'
const sameCandle = (a: Candle, b: Candle): boolean => a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v

/** buf[a, b) 是一行 JSON；不是有效 K 线 → undefined。 */
function parseLine(buf: Buffer, a: number, b: number): Candle | undefined {
  if (b <= a) return undefined
  try { return toCandle(JSON.parse(buf.toString('utf8', a, b))) } catch { return undefined }
}

/**
 * 一条序列的内存索引：升序唯一的 t，以及每个 t「最后一次出现」那一行的字节偏移 / 长度（不含换行）。
 * size = 已并进索引的字节数，总是停在行尾；文件变长就只扫新增的尾巴。约 24 B/根。
 * ponytail: 索引只在内存里，进程重启后第一次访问整文件扫一遍（20 万行约 0.3 s），之后都走索引；
 * 单进程内没有淘汰——序列很多、很长时再加 LRU 或落盘索引。
 */
interface SeriesIndex { ino: bigint; size: number; ts: number[]; off: number[]; len: number[] }

/** 每个文件一把串行锁，进程内所有 FileCandleStore 实例共用：同一文件的读索引 / 查重 / 追加不交错。 */
const locks = new Map<string, Promise<void>>()
function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(path) ?? Promise.resolve()).then(fn)
  const tail = run.then(() => undefined, () => undefined)
  locks.set(path, tail)
  void tail.then(() => { if (locks.get(path) === tail) locks.delete(path) })
  return run
}

/** 第一个 ≥ x 的下标。 */
function lowerBound(a: readonly number[], x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (a[mid]! < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

const SCAN_CHUNK = 4 * 1024 * 1024
/** 读命中的行时，相邻两行间隔不超过它就合成一次读。 */
const READ_GAP = 64 * 1024
const READ_MAX = 8 * 1024 * 1024

/** 把一批「按文件顺序」的行并进索引：同 t 取最后出现的行；新行覆盖已有索引里的同 t。 */
function mergeRows(ix: SeriesIndex, t: number[], off: number[], len: number[]): void {
  if (t.length === 0) return
  let ordered = true
  for (let i = 1; i < t.length; i++) if (!(t[i]! > t[i - 1]!)) { ordered = false; break }
  if (!ordered) {
    const order = t.map((_, i) => i).sort((a, b) => t[a]! - t[b]! || a - b)
    const t2: number[] = []
    const o2: number[] = []
    const l2: number[] = []
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!
      if (k + 1 < order.length && t[order[k + 1]!] === t[i]) continue // 同 t 后面还有更晚的行
      t2.push(t[i]!); o2.push(off[i]!); l2.push(len[i]!)
    }
    t = t2; off = o2; len = l2
  }
  const n = ix.ts.length
  if (n === 0 || t[0]! > ix.ts[n - 1]!) {
    for (let i = 0; i < t.length; i++) { ix.ts.push(t[i]!); ix.off.push(off[i]!); ix.len.push(len[i]!) }
    return
  }
  const ts: number[] = []
  const os: number[] = []
  const ls: number[] = []
  let a = 0
  let b = 0
  while (a < n || b < t.length) {
    if (b >= t.length || (a < n && ix.ts[a]! < t[b]!)) { ts.push(ix.ts[a]!); os.push(ix.off[a]!); ls.push(ix.len[a]!); a++ }
    else if (a >= n || t[b]! < ix.ts[a]!) { ts.push(t[b]!); os.push(off[b]!); ls.push(len[b]!); b++ }
    else { ts.push(t[b]!); os.push(off[b]!); ls.push(len[b]!); a++; b++ } // 同 t：新行为准
  }
  ix.ts = ts; ix.off = os; ix.len = ls
}

export class FileCandleStore {
  constructor(readonly dir: string) {}
  /** 每个 key 本进程已录的最大 t（给轮询去重用；重启后从空开始，写入时仍按已有内容去重）。 */
  private readonly maxT = new Map<string, number>()
  private readonly idx = new Map<string, SeriesIndex>()

  /** <dir>/<venue>/<symbol>/<interval>.jsonl；venue = instrumentId 第一个冒号前，symbol = 冒号后；两段都把 [^A-Za-z0-9._-] 替换成 '_'；interval 同样处理。 */
  pathFor(instrumentId: string, interval: string): string {
    const i = instrumentId.indexOf(':')
    const venue = i < 0 ? instrumentId : instrumentId.slice(0, i)
    const symbol = i < 0 ? '' : instrumentId.slice(i + 1)
    return join(this.dir, sanitize(venue), sanitize(symbol), `${sanitize(fileInterval(interval))}.jsonl`)
  }

  /** 让索引追上文件：没有 → 建；文件变长 → 只扫新增的尾巴；被换掉 / 变短 → 重建。文件不存在返回 null。调用方须持有该文件的锁。 */
  private async sync(path: string): Promise<SeriesIndex | null> {
    let st: BigIntStats
    try { st = await stat(path, { bigint: true }) } catch { this.idx.delete(path); return null }
    const size = Number(st.size)
    let ix = this.idx.get(path)
    if (ix && (ix.ino !== st.ino || size < ix.size)) ix = undefined
    if (!ix) { ix = { ino: st.ino, size: 0, ts: [], off: [], len: [] }; this.idx.set(path, ix) }
    if (size > ix.size) await this.scan(path, ix, size)
    return ix
  }

  /** 扫 [ix.size, end) 里的整行并进索引；末尾没有换行的残行留着不并（等它写完）。 */
  private async scan(path: string, ix: SeriesIndex, end: number): Promise<void> {
    const fh = await open(path, 'r')
    try {
      const t: number[] = []
      const off: number[] = []
      const len: number[] = []
      let pos = ix.size
      let carry: Buffer = Buffer.alloc(0)
      let consumed = ix.size
      while (pos < end) {
        const want = Math.min(SCAN_CHUNK, end - pos)
        const buf = Buffer.allocUnsafe(want)
        const { bytesRead } = await fh.read(buf, 0, want, pos)
        if (bytesRead === 0) break
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
        const base = pos - carry.length
        let lineStart = 0
        for (let nl = chunk.indexOf(10, lineStart); nl >= 0; nl = chunk.indexOf(10, lineStart)) {
          const c = parseLine(chunk, lineStart, nl)
          if (c) { t.push(c.t); off.push(base + lineStart); len.push(nl - lineStart) }
          lineStart = nl + 1
        }
        carry = Buffer.from(chunk.subarray(lineStart))
        consumed = base + lineStart
        pos += bytesRead
      }
      ix.size = consumed
      mergeRows(ix, t, off, len)
    } finally {
      await fh.close()
    }
  }

  /** 按索引下标取行（返回顺序同 pos）；文件在背后被改、解析不了的行丢弃。 */
  private async rowsAt(path: string, ix: SeriesIndex, pos: readonly number[]): Promise<Candle[]> {
    if (pos.length === 0) return []
    const out: Array<Candle | undefined> = new Array<Candle | undefined>(pos.length)
    const items = pos.map((p, i) => ({ i, off: ix.off[p]!, len: ix.len[p]! })).sort((a, b) => a.off - b.off)
    const fh = await open(path, 'r')
    try {
      let k = 0
      while (k < items.length) {
        let j = k
        let end = items[k]!.off + items[k]!.len
        while (j + 1 < items.length) {
          const nx = items[j + 1]!
          if (nx.off - end > READ_GAP || nx.off + nx.len - items[k]!.off > READ_MAX) break
          j++
          end = Math.max(end, nx.off + nx.len)
        }
        const base = items[k]!.off
        const buf = Buffer.allocUnsafe(end - base)
        const { bytesRead } = await fh.read(buf, 0, buf.length, base)
        for (let q = k; q <= j; q++) {
          const it = items[q]!
          if (it.off - base + it.len <= bytesRead) out[it.i] = parseLine(buf, it.off - base, it.off - base + it.len)
        }
        k = j + 1
      }
    } finally {
      await fh.close()
    }
    return out.filter((c): c is Candle => c !== undefined)
  }

  /** 追加：丢弃 t/o/h/l/c 非有限数的项（v 缺省 0）；本次调用内按 t 去重保留后出现、升序；与库里已有行完全相同的根不再写；返回实际写入的根数。 */
  private async write(instrumentId: string, interval: string, candles: readonly Candle[]): Promise<number> {
    const byT = new Map<number, Candle>()
    for (const raw of candles) {
      const c = toCandle(raw)
      if (c) byT.set(c.t, c)
    }
    if (byT.size === 0) return 0
    const incoming = [...byT.values()].sort((a, b) => a.t - b.t)
    const path = this.pathFor(instrumentId, interval)
    return withLock(path, async () => {
      const ix = await this.sync(path)
      let fresh = incoming
      if (ix && ix.ts.length > 0) {
        const hits = incoming.map((c) => ({ c, p: lowerBound(ix.ts, c.t) })).filter((h) => ix.ts[h.p] === h.c.t)
        if (hits.length > 0) {
          const have = await this.rowsAt(path, ix, hits.map((h) => h.p))
          const same = new Set(have.filter((e) => sameCandle(e, byT.get(e.t)!)).map((e) => e.t))
          fresh = incoming.filter((c) => !same.has(c.t))
        }
      }
      if (fresh.length === 0) return 0
      await mkdir(dirname(path), { recursive: true })
      // 文件尾有没写完的残行时先补一个换行，免得新行粘在它后面
      const st = await stat(path, { bigint: true }).catch(() => null)
      const lead = st && ix && Number(st.size) > ix.size ? '\n' : ''
      await appendFile(path, lead + fresh.map(lineOf).join(''), 'utf8')
      await this.sync(path)
      return fresh.length
    })
  }

  /** 追加（见 write）。空数组不写。 */
  async record(instrumentId: string, interval: string, candles: readonly Candle[]): Promise<void> {
    await this.write(instrumentId, interval, candles)
  }

  /** 只追加比本进程已录最大 t 更新的根（轮询同一窗口时不重复落盘）；返回实际写入的根数。 */
  async recordNew(instrumentId: string, interval: string, candles: readonly Candle[]): Promise<number> {
    const key = `${instrumentId}|${interval}`
    const max = this.maxT.get(key) ?? -Infinity
    const fresh = candles.filter((c) => Number.isFinite(c.t) && c.t > max)
    if (fresh.length === 0) return 0
    // 先记后写：并发的两次轮询（写盘未完成时第二次已到）不会把同一批重复追加；写失败只是少录，读时仍按 t 去重。
    this.maxT.set(key, Math.max(...fresh.map((c) => c.t)))
    return this.write(instrumentId, interval, fresh)
  }

  /** 区间内已有的 t（只查索引，不读行）：[from, to) 升序；序列不存在 → []。 */
  async times(instrumentId: string, interval: string, opts: { from?: number; to?: number } = {}): Promise<number[]> {
    const path = this.pathFor(instrumentId, interval)
    return withLock(path, async () => {
      const ix = await this.sync(path)
      if (!ix) return []
      const lo = opts.from !== undefined ? lowerBound(ix.ts, opts.from) : 0
      const hi = opts.to !== undefined ? lowerBound(ix.ts, opts.to) : ix.ts.length
      return hi > lo ? ix.ts.slice(lo, hi) : []
    }).catch(() => [])
  }

  /** 读：文件不存在 → []；坏行跳过；按 t 去重后写覆盖先写；升序；from/to 为 [from, to) 过滤；n → 只留最后 n 根。 */
  async read(instrumentId: string, interval: string, opts: StoreReadOpts = {}): Promise<Candle[]> {
    if (Number.isNaN(opts.from) || Number.isNaN(opts.to)) return []
    const path = this.pathFor(instrumentId, interval)
    return withLock(path, async () => {
      const ix = await this.sync(path)
      if (!ix) return []
      let lo = opts.from !== undefined ? lowerBound(ix.ts, opts.from) : 0
      const hi = Math.max(lo, opts.to !== undefined ? lowerBound(ix.ts, opts.to) : ix.ts.length)
      if (opts.n !== undefined) {
        if (opts.n <= 0) return []
        lo = Math.max(lo, hi - opts.n)
      }
      return this.rowsAt(path, ix, Array.from({ length: hi - lo }, (_, i) => lo + i))
    }).catch(() => [])
  }

  /** 压实：read 全量后用 writeFileAtomic 原子重写为去重升序的 JSONL；返回重写后的行数；文件不存在返回 0。 */
  async compact(instrumentId: string, interval: string): Promise<number> {
    const path = this.pathFor(instrumentId, interval)
    if (!existsSync(path)) return 0
    return withLock(path, async () => {
      const ix = await this.sync(path)
      if (!ix) return 0
      const candles = await this.rowsAt(path, ix, Array.from({ length: ix.ts.length }, (_, i) => i))
      writeFileAtomic(path, candles.map(lineOf).join(''))
      this.idx.delete(path)
      return candles.length
    })
  }

  /** 已有文件的 (instrumentId, interval) 列表：按目录结构还原（venue/symbol/interval 反向拼接，用 ':' 连 venue 与 symbol，interval 去掉 .jsonl）；目录不存在 → []。 */
  async list(): Promise<{ instrumentId: string; interval: string; path: string }[]> {
    const out: { instrumentId: string; interval: string; path: string }[] = []
    let venues: Dirent[]
    try {
      venues = await readdir(this.dir, { withFileTypes: true })
    } catch {
      return []
    }
    for (const v of venues) {
      if (!v.isDirectory()) continue
      let symbols: Dirent[]
      try {
        symbols = await readdir(join(this.dir, v.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of symbols) {
        if (!s.isDirectory()) continue
        let files: Dirent[]
        try {
          files = await readdir(join(this.dir, v.name, s.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
          out.push({
            instrumentId: `${v.name}:${s.name}`,
            interval: fromFileInterval(f.name.slice(0, -'.jsonl'.length)),
            path: join(this.dir, v.name, s.name, f.name),
          })
        }
      }
    }
    return out
  }
}

/**
 * 把总线上的 K 线事件录进库：只录「已收盘」的——同一 key = `${instrumentId}|${interval}` 出现 t 更大的一根时，把上一根 record 进去；
 * t 相同 → 替换暂存（形成中的更新）；t 更小 → 忽略。返回退订函数。record 的异常吞掉（库是尽力而为），但要调用 opts.onError。
 */
export function attachClosedCandleRecorder(events: EventBus, store: FileCandleStore, opts: { onError?: (e: unknown) => void } = {}): Unsubscribe {
  const pending = new Map<string, Candle>()
  return events.subscribe('market.candles', (e: KernelEvent) => {
    const data = e.data
    if (typeof data !== 'object' || data === null) return
    const d = data as Record<string, unknown>
    const instrumentId = d.instrumentId
    const interval = d.interval
    const candles = d.candles
    if (typeof instrumentId !== 'string' || typeof interval !== 'string' || !Array.isArray(candles)) return
    const key = `${instrumentId}|${interval}`
    for (const raw of candles) {
      const c = toCandle(raw)
      if (!c) continue
      const prev = pending.get(key)
      if (prev && c.t > prev.t) {
        void store.record(instrumentId, interval, [prev]).catch((err) => opts.onError?.(err))
      } else if (prev && c.t < prev.t) {
        continue
      }
      pending.set(key, c)
    }
  })
}
