// SPDX-License-Identifier: CPAL-1.0
// 宿主 K 线的本地文件缓存（尽力而为）：目录来自环境变量 GITRADER_ENGINE_CACHE_DIR；没有就不缓存。
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Candle } from '../types'

/** env.GITRADER_ENGINE_CACHE_DIR 为非空字符串 → 返回它；否则 null（禁用）。 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.GITRADER_ENGINE_CACHE_DIR
  return typeof v === 'string' && v !== '' ? v : null
}

/** = createHash('sha256').update(`${instrumentId}|${interval}|${from}|${to}`).digest('hex')（64 位十六进制）。 */
export function cacheKey(instrumentId: string, interval: string, from: number, to: number): string {
  return createHash('sha256').update(`${instrumentId}|${interval}|${from}|${to}`).digest('hex')
}

/** 文件路径 = join(dir, 'candles', `${key}.json.gz`)。 */
export function cachePath(dir: string, key: string): string {
  return join(dir, 'candles', `${key}.json.gz`)
}

/** 旧格式（明文）缓存路径 = join(dir, 'candles', `${key}.json`)；只用于读取兼容。 */
function legacyCachePath(dir: string, key: string): string {
  return join(dir, 'candles', `${key}.json`)
}

/** 缓存总大小上限（字节）：env.GITRADER_ENGINE_CACHE_MAX_MB 为正数 → 按 MB 换算；非正 / 非数 → 2048 MB。 */
function cacheMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GITRADER_ENGINE_CACHE_MAX_MB
  const mb = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  const bounded = Number.isFinite(mb) && mb > 0 ? mb : 2048
  return Math.floor(bounded * 1024 * 1024)
}

/** 是否为缓存文件（只认 .json / .json.gz 两种后缀）。 */
function isCacheFile(name: string): boolean {
  return name.endsWith('.json') || name.endsWith('.json.gz')
}

/** 解析 K 线数组文本：非法 JSON / 不是数组 → null；逐项校验 {t,o,h,l,c,v?}（t,o,h,l,c 为有限数，v 缺省 0，非有限数项丢弃）；结果为空 → null。 */
function parseCandles(text: string): Candle[] | null {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(j)) return null
  const out: Candle[] = []
  for (const x of j) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const o = x as Record<string, unknown>
    const t = o.t, open = o.o, h = o.h, l = o.l, c = o.c, v = o.v ?? 0
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    if (typeof open !== 'number' || !Number.isFinite(open)) continue
    if (typeof h !== 'number' || !Number.isFinite(h)) continue
    if (typeof l !== 'number' || !Number.isFinite(l)) continue
    if (typeof c !== 'number' || !Number.isFinite(c)) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out.push({ t, o: open, h, l, c, v })
  }
  return out.length === 0 ? null : out
}

/** 读一个缓存文件：不存在 / 读失败 / 解压失败 / 解析失败 → null；gz=true 时按 gzip 解压。 */
async function loadCacheFile(path: string, gz: boolean): Promise<Candle[] | null> {
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    return null
  }
  if (gz) {
    try {
      buf = gunzipSync(buf)
    } catch {
      return null
    }
  }
  return parseCandles(buf.toString('utf8'))
}

/** 命中后把 mtime 刷新到现在（LRU 清理按 mtime 排序）；失败吞掉。 */
async function touch(path: string): Promise<void> {
  try {
    const now = new Date()
    await utimes(path, now, now)
  } catch {
    // mtime 刷新是尽力而为
  }
}

/** 读缓存：先找 `<key>.json.gz`（解压后解析），没有再找旧的 `<key>.json`；命中时刷新 mtime；坏文件 → null。 */
export async function readCache(dir: string, key: string): Promise<Candle[] | null> {
  const gzPath = cachePath(dir, key)
  const gz = await loadCacheFile(gzPath, true)
  if (gz !== null) {
    await touch(gzPath)
    return gz
  }
  const plainPath = legacyCachePath(dir, key)
  const plain = await loadCacheFile(plainPath, false)
  if (plain !== null) {
    await touch(plainPath)
    return plain
  }
  return null
}

/** 写缓存：mkdir(join(dir,'candles'), { recursive: true })；只写 `<key>.json.gz`（gzipSync）：先写临时文件再 rename；写完按总大小上限清理；任何错误吞掉不抛。 */
export async function writeCache(dir: string, key: string, candles: readonly Candle[]): Promise<void> {
  const json = JSON.stringify(candles)
  const gzPath = cachePath(dir, key)
  try {
    await mkdir(join(dir, 'candles'), { recursive: true })
    // Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/backtest_cache.py:69; adapted (no TTL: only immutable past ranges are cached).
    const gzTmp = `${gzPath}.${process.pid}.tmp`
    await writeFile(gzTmp, gzipSync(json))
    await rename(gzTmp, gzPath)
  } catch {
    // 缓存是尽力而为：失败就当没缓存
  }
  await prune(dir)
}

/** 按 mtime 升序删除 candles/ 下的缓存文件，直到总大小不超过上限；只剩一个文件时保留它（最新一份可能超限）。任何错误吞掉。 */
async function prune(dir: string): Promise<void> {
  try {
    const root = join(dir, 'candles')
    const max = cacheMaxBytes()
    const names = (await readdir(root)).filter(isCacheFile)
    const files: { path: string; mtimeMs: number; size: number }[] = []
    for (const name of names) {
      const path = join(root, name)
      try {
        const s = await stat(path)
        if (s.isFile()) files.push({ path, mtimeMs: s.mtimeMs, size: s.size })
      } catch {
        // 单个文件 stat 失败：跳过
      }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
    let total = 0
    for (const f of files) total += f.size
    while (total > max && files.length > 1) {
      const oldest = files.shift()
      if (!oldest) break
      try {
        await unlink(oldest.path)
      } catch {
        // 删除失败：跳过，继续淘汰下一个
      }
      total -= oldest.size
    }
  } catch {
    // 清理是尽力而为
  }
}

/** 统计 candles/ 下 .json / .json.gz 的文件数与总字节数（目录不存在 → 0/0）。 */
export async function cacheStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  try {
    const root = join(dir, 'candles')
    for (const name of (await readdir(root)).filter(isCacheFile)) {
      try {
        const s = await stat(join(root, name))
        if (!s.isFile()) continue
        files += 1
        bytes += s.size
      } catch {
        // 单个文件 stat 失败：跳过
      }
    }
  } catch {
    // 目录不存在 / 不可读：按空缓存处理
  }
  return { files, bytes }
}
