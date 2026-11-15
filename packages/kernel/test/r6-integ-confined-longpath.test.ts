// SPDX-License-Identifier: CPAL-1.0
// R2-REL-04 根因（集成项）：Windows 上路径接近 260 字符时，Node 的 JS 版 fs.realpathSync 会抛 EISDIR（lstat 'D:'），
// resolveConfinedPath → realPathWithMissingTail 因此在长路径下一律失败。修在共用函数里：JS 版失败就回退 realpathSync.native。
// 第一组用真实的长目录（Windows 上就是 bug 现场）；第二组用模拟的 EISDIR，任何平台都能验证「回退」这条路。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, toNamespacedPath } from 'node:path'

const sim = vi.hoisted(() => ({ eisdirOverChars: 0, calls: { js: 0, native: 0 } }))
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  const js = ((p: Parameters<typeof real.realpathSync>[0], o?: Parameters<typeof real.realpathSync>[1]) => {
    sim.calls.js++
    if (sim.eisdirOverChars > 0 && String(p).length > sim.eisdirOverChars) throw Object.assign(new Error("EISDIR: illegal operation on a directory, lstat 'D:'"), { code: 'EISDIR' })
    return real.realpathSync(p, o)
  }) as typeof real.realpathSync
  js.native = ((p: Parameters<typeof real.realpathSync.native>[0], o?: Parameters<typeof real.realpathSync.native>[1]) => { sim.calls.native++; return real.realpathSync.native(p, o) }) as typeof real.realpathSync.native
  return { ...real, realpathSync: js }
})

import { resolveConfinedPath } from '../src/util/confined-path'

const roots: string[] = []
afterEach(() => {
  sim.eisdirOverChars = 0; sim.calls.js = 0; sim.calls.native = 0
  for (const r of roots.splice(0)) { try { rmSync(process.platform === 'win32' ? toNamespacedPath(resolve(r)) : r, { recursive: true, force: true, maxRetries: 5 }) } catch { /* 尽力清理 */ } }
})

/** 造一个超过 length 个字符的目录（逐级建，每级 40 字符）。 */
function longDir(length: number): string {
  const root = mkdtempSync(join(tmpdir(), 'gt-cp-'))
  roots.push(root)
  let dir = root
  while (dir.length <= length) dir = join(dir, 'd'.repeat(40))
  mkdirSync(process.platform === 'win32' ? toNamespacedPath(resolve(dir)) : dir, { recursive: true })
  return dir
}
const long = (p: string): string => (process.platform === 'win32' ? toNamespacedPath(resolve(p)) : p)

describe('resolveConfinedPath 在长路径下可用（真实长目录）', () => {
  it('根目录超过 260 字符：不存在的文件、已存在的文件、尚不存在的子目录都能解析，仍在根里', () => {
    const root = longDir(280)
    expect(root.length).toBeGreaterThan(260)
    expect(resolveConfinedPath(root, 'cache.json', { anchorRoot: root })).toBe(join(root, 'cache.json'))
    writeFileSync(long(join(root, 'cache.json')), '{}')
    expect(existsSync(long(join(root, 'cache.json')))).toBe(true)
    expect(resolveConfinedPath(root, 'cache.json', { anchorRoot: root, mustExist: true })).toBe(join(root, 'cache.json'))
    expect(resolveConfinedPath(root, 'sub/not-yet/file.txt')).toBe(join(root, 'sub', 'not-yet', 'file.txt'))
  })

  it('长路径下越界照旧被拒：.. / 绝对路径 / 不存在的文件 + mustExist', () => {
    const root = longDir(280)
    expect(() => resolveConfinedPath(root, '../escape.txt')).toThrow('invalid workspace path')
    expect(() => resolveConfinedPath(root, join(tmpdir(), 'other.txt'))).toThrow('invalid workspace path')
    expect(() => resolveConfinedPath(root, 'missing.txt', { mustExist: true })).toThrow('invalid workspace path')
  })
})

describe('JS 版 realpathSync 抛 EISDIR 时回退 native（模拟，任何平台）', () => {
  it('根目录超过阈值时 JS 版全部抛 EISDIR：仍然解析成功，且确实走了 native', () => {
    const root = longDir(280)
    sim.eisdirOverChars = 260
    expect(resolveConfinedPath(root, 'cache.json', { anchorRoot: root })).toBe(join(root, 'cache.json'))
    expect(sim.calls.native).toBeGreaterThan(0)
    expect(resolveConfinedPath(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'))
  })

  it('回退之后越界检查仍在：.. 和 mustExist 照样拒绝', () => {
    const root = longDir(280)
    sim.eisdirOverChars = 260
    expect(() => resolveConfinedPath(root, '../escape.txt', { anchorRoot: root })).toThrow('invalid workspace path')
    expect(() => resolveConfinedPath(root, 'missing.txt', { mustExist: true })).toThrow('invalid workspace path')
  })

  it('短路径不受影响：JS 版能用就不碰 native', () => {
    const root = mkdtempSync(join(tmpdir(), 'gt-cp-'))
    roots.push(root)
    expect(resolveConfinedPath(root, 'x.txt')).toBe(join(root, 'x.txt'))
    expect(sim.calls.native).toBe(0)
  })
})
