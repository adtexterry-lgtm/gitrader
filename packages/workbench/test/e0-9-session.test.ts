// SPDX-License-Identifier: CPAL-1.0
// E0-9：会话跨刷新留在本标签页的 sessionStorage（纯函数 + 假 storage，不起浏览器）；失效页 / 服务端顶部提示给的是照字面能走通的步骤。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SESSION_STORE_KEY, clearSession, loadSession, saveSession } from '../src/core/session'
import type { Session } from '../src/core/session'
import { RELINK_HINT } from '../../kernel/src/http/server'

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

interface FakeStore extends StorageLike { readonly map: Map<string, string>; readonly writes: string[] }

function fakeStore(): FakeStore {
  const map = new Map<string, string>()
  const writes: string[] = []
  return {
    map,
    writes,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(k); map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
  }
}

const session: Session = { token: 'st_abc', user: 'usr_local', wsUrl: 'ws://127.0.0.1:47900/ui' }

describe('会话存取', () => {
  it('save then load round-trips', () => {
    const store = fakeStore()
    saveSession(store, session)
    expect(store.writes).toEqual([SESSION_STORE_KEY])
    expect(JSON.parse(store.map.get(SESSION_STORE_KEY) ?? '{}')).toEqual({ token: 'st_abc', user: 'usr_local', wsUrl: 'ws://127.0.0.1:47900/ui' })
    expect(loadSession(store)).toEqual(session)
    clearSession(store)
    expect(store.map.has(SESSION_STORE_KEY)).toBe(false)
    expect(loadSession(store)).toBeNull()
  })

  it('broken json is cleared', () => {
    const bad = fakeStore()
    bad.map.set(SESSION_STORE_KEY, '{"token":')
    expect(loadSession(bad)).toBeNull()
    expect(bad.map.has(SESSION_STORE_KEY)).toBe(false)

    const partial = fakeStore()
    partial.map.set(SESSION_STORE_KEY, JSON.stringify({ token: 'st_abc', user: 'usr_local' }))
    expect(loadSession(partial)).toBeNull()
    expect(partial.map.has(SESSION_STORE_KEY)).toBe(false)

    const notObject = fakeStore()
    notObject.map.set(SESSION_STORE_KEY, '"st_abc"')
    expect(loadSession(notObject)).toBeNull()
    expect(notObject.map.has(SESSION_STORE_KEY)).toBe(false)
  })

  it('null storage is tolerated', () => {
    expect(() => saveSession(null, session)).not.toThrow()
    expect(() => saveSession(undefined, session)).not.toThrow()
    expect(loadSession(null)).toBeNull()
    expect(loadSession(undefined)).toBeNull()
    expect(() => clearSession(null)).not.toThrow()
    expect(() => clearSession(undefined)).not.toThrow()
    const throwing: StorageLike = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(() => saveSession(throwing, session)).not.toThrow()
    expect(loadSession(throwing)).toBeNull()
    expect(() => clearSession(throwing)).not.toThrow()
  })
})

describe('失效页与服务端提示', () => {
  it('dead card text lists runnable steps', () => {
    const src = readFileSync(new URL('../src/shell/Shell.jsx', import.meta.url), 'utf8')
    expect(src).toContain('gitrader serve')
    expect(src).toContain('按 Enter')
    expect(src).toContain('gitrader open')
    expect(src).not.toContain('open --print')
    // fix-r4：失效页主句是 gitrader open，serve 窗口按 Enter 是次句；复制按钮复制 gitrader open
    expect(src).toContain("RELINK_CMD = 'gitrader open'")
    expect(src).toContain('登录已过期。在终端运行')
  })

  it('server hint is chinese', () => {
    expect(RELINK_HINT).toContain('gitrader open')
    expect(RELINK_HINT).not.toContain('This session')
  })
})
