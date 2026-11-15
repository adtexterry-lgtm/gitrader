// SPDX-License-Identifier: CPAL-1.0
// R2-REL-04：数据目录路径超过 260 字符时权限收紧照样做得到；收紧失败的调用方要么抛错要么报出，不许静默。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, toNamespacedPath } from 'node:path'

const failing = vi.hoisted(() => ({ on: false }))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return { ...real, execFileSync: ((cmd: string, ...rest: unknown[]) => {
    if (failing.on && /(^|[\\/])icacls(\.exe)?$/i.test(cmd)) throw new Error('icacls failed (test)') // 裸名或 System32 绝对路径都拦
    return (real.execFileSync as (...a: unknown[]) => unknown)(cmd, ...rest)
  }) as typeof real.execFileSync }
})
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, chmodSync: ((...a: Parameters<typeof real.chmodSync>) => {
    if (failing.on) throw new Error('chmod failed (test)')
    return real.chmodSync(...a)
  }) as typeof real.chmodSync }
})

import { tightenFile, writeSecretFile } from '../src/util/fsperm'
import { InstallKey } from '../src/install-key'

const roots: string[] = []
afterEach(() => {
  failing.on = false
  for (const r of roots.splice(0)) { try { rmSync(process.platform === 'win32' ? toNamespacedPath(resolve(r)) : r, { recursive: true, force: true }) } catch { /* 尽力清理 */ } }
})

/** 造一个超过 length 个字符的目录（逐级建，每级 40 字符）。 */
function longDir(length: number): string {
  const root = mkdtempSync(join(tmpdir(), 'gt-lp-'))
  roots.push(root)
  let dir = root
  while (dir.length <= length) dir = join(dir, 'd'.repeat(40))
  mkdirSync(process.platform === 'win32' ? toNamespacedPath(resolve(dir)) : dir, { recursive: true })
  return dir
}

/** Windows：用 icacls 读 ACL（带长路径前缀才读得到长路径），返回原文。 */
function aclText(path: string): string {
  return execFileSync('icacls', [toNamespacedPath(resolve(path))], { encoding: 'utf8', windowsHide: true })
}

describe('R2-REL-04 长路径下的权限收紧', () => {
  it('[R6F-LP1] tightenFile works on a path longer than 260 characters (long-path prefix or equivalent)', () => {
    const dir = longDir(300)
    const file = join(dir, 'secret.json')
    expect(file.length).toBeGreaterThan(260)
    expect(writeSecretFile(file, '{"k":1}')).toBe(true)
    expect(readFileSync(process.platform === 'win32' ? toNamespacedPath(resolve(file)) : file, 'utf8')).toBe('{"k":1}')
    // 对已存在的长路径文件再收紧一次也成功
    expect(tightenFile(file)).toBe(true)
    if (process.platform === 'win32') {
      const acl = aclText(file)
      expect(acl, acl).not.toMatch(/\(I\)/) // 去掉继承
      expect((acl.match(/:\(/g) ?? []).length, acl).toBe(1) // 只有当前用户一条允许项
    } else {
      expect(statSync(file).mode & 0o077).toBe(0)
    }
  })

  it('[R6F-LP2] tightening failure is never silent: every writeSecretFile caller throws or reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-lp2-'))
    roots.push(dir)
    // 1) 非 strict：写了文件，但返回 false，调用方必须看返回值
    failing.on = true
    const loose = join(dir, 'service.json')
    expect(writeSecretFile(loose, '{}')).toBe(false)
    expect(existsSync(loose)).toBe(true)
    // 2) strict：抛错，目标文件和临时文件都不留
    const strict = join(dir, 'pin.json')
    expect(() => writeSecretFile(strict, '{}', { strict: true })).toThrow(/cannot restrict permissions|无法把密钥文件的权限收紧/)
    expect(existsSync(strict)).toBe(false)
    expect(readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([])
    // 3) 真实调用方（安装签名钥）：收紧失败 = 拒绝创建
    const keyPath = join(dir, 'keys', 'install-key.json')
    expect(() => InstallKey.loadOrCreate(keyPath)).toThrow(/cannot restrict permissions|无法把密钥文件的权限收紧/)
    expect(existsSync(keyPath)).toBe(false)
    failing.on = false
    expect(() => InstallKey.loadOrCreate(keyPath)).not.toThrow()
    expect(existsSync(keyPath)).toBe(true)
  })

  it('[R6F-LP3] strict write failure names both causes (path too long / file system without permissions) and suggests a local NTFS disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-lp3-'))
    roots.push(dir)
    failing.on = true
    const msg = (f: () => unknown): string => { try { f() } catch (e) { return (e as { problem?: { message?: string } }).problem?.message ?? String(e) } return '' }
    const direct = msg(() => writeSecretFile(join(dir, 'pin.json'), '{}', { strict: true }))
    const viaInstallKey = msg(() => InstallKey.loadOrCreate(join(dir, 'keys', 'install-key.json')))
    for (const m of [direct, viaInstallKey]) {
      expect(m).toContain('cannot restrict permissions') // 仍然是拒绝写入，没有放宽
      expect(m).toMatch(/path is too long/)
      expect(m).toMatch(/exFAT \/ FAT32/)
      expect(m).toMatch(/network drive/)
      expect(m).toMatch(/local NTFS disk/)
      expect(m).toMatch(/路径过长/)
      expect(m).toMatch(/不支持权限/)
      expect(m).toMatch(/exFAT \/ FAT32 的 U 盘、网络盘/)
      expect(m).toMatch(/NTFS 盘/)
    }
    expect(existsSync(join(dir, 'pin.json'))).toBe(false)
    expect(existsSync(join(dir, 'keys', 'install-key.json'))).toBe(false)
  })

  it('[R6F-LP2] 源码守卫：writeSecretFile 的每个调用点都用了 strict 或检查了返回值', () => {
    const srcRoots = [join(__dirname, '..', 'src'), join(__dirname, '..', '..', 'cli', 'src')]
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : [])
    const sites: string[] = []
    for (const file of srcRoots.flatMap(walk)) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (!/writeSecretFile\(/.test(line) || /^\s*(import|export|\/\/|\*)/.test(line)) return
        const ok = /strict:\s*true/.test(line) || /(=|=>|return|if\s*\(\s*!?)\s*\(?\s*writeSecretFile\(/.test(line)
        if (!ok) sites.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(sites).toEqual([])
  })
})
