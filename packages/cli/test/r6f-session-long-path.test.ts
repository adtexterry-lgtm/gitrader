// SPDX-License-Identifier: CPAL-1.0
// R2-REL-04：数据目录超过 260 字符时 `gitrader session login` 照样能登录、缓存文件只有当前用户可读、之后的命令读得到会话。
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, toNamespacedPath } from 'node:path'
import { fileProvider } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'
import { readCachedSession } from '../src/session'

let root: string | undefined
let service: ServeHandle | undefined
afterEach(async () => {
  await service?.stop().catch(() => undefined)
  service = undefined
  if (root) { try { rmSync(process.platform === 'win32' ? toNamespacedPath(resolve(root)) : root, { recursive: true, force: true, maxRetries: 5 }) } catch { /* 尽力清理 */ } }
  root = undefined
})

describe('R2-REL-04 长路径下 session login', () => {
  it('logs in under a data directory longer than 260 characters and the cache is owner-only', async () => {
    root = mkdtempSync(join(tmpdir(), 'gt-r6f-sess-'))
    let home = root
    while (home.length <= 290) home = join(home, 'h'.repeat(40))
    const longHome = join(home, 'home')
    mkdirSync(process.platform === 'win32' ? toNamespacedPath(resolve(longHome)) : longHome, { recursive: true })
    expect(longHome.length).toBeGreaterThan(260)

    const out: string[] = []; const err: string[] = []; let secret = ''
    const io = (): CliIo => ({
      out: (v) => out.push(v), err: (v) => err.push(v), env: { GITRADER_HOME: longHome }, interactive: true, deviceKey: fileProvider,
      readSecret: async () => secret,
    })
    expect(await main(['init', '--no-pin'], io()), err.join('')).toBe(0)
    service = await runServe(longHome, { port: 0, io: io(), connectors: false })
    secret = service.kernel.auth.mintBootToken()
    expect(await main(['session', 'login'], io()), err.join('')).toBe(0)

    const cachePath = join(longHome, 'cli-session.json')
    const long = process.platform === 'win32' ? toNamespacedPath(resolve(cachePath)) : cachePath
    expect(existsSync(long)).toBe(true)
    const cache = JSON.parse(readFileSync(long, 'utf8')) as { sessionToken: string }
    // 之后的命令能读到这条会话
    const session = readCachedSession(longHome, { baseUrl: service.url, startedAt: service.kernel.startedAt })
    expect(session.sessionToken).toBe(cache.sessionToken)
    if (process.platform === 'win32') {
      const acl = execFileSync('icacls', [long], { encoding: 'utf8', windowsHide: true })
      expect(acl, acl).not.toMatch(/\(I\)/)
      expect((acl.match(/:\(/g) ?? []).length, acl).toBe(1)
    }
  }, 60_000)
})
