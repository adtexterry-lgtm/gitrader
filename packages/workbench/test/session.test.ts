// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PrefsStore, effectiveDensity } from '../src/core/prefs'
import { ACTOR_FILTERS, actorKind, matchesActorFilter, originActorType } from '../src/core/actor'
import { SessionError, exchangeSession, takeBootstrap } from '../src/core/session'
import { startFakeKernel, type FakeKernel } from '@gitrader/blocks-sdk/testing'

describe('鉴权引导', () => {
  it('读完引导令牌后从 DOM 抹掉', () => {
    let removed = false
    const doc = { querySelector: () => ({ getAttribute: () => ' boot-123 ', remove: () => { removed = true } }) }
    expect(takeBootstrap(doc)).toBe('boot-123')
    expect(removed).toBe(true)
    expect(takeBootstrap({ querySelector: () => null })).toBeNull()
  })

  describe('与内核换票', () => {
    let k: FakeKernel
    beforeEach(async () => { k = await startFakeKernel() })
    afterEach(async () => { await k.close() })

    it('一次性引导令牌换会话令牌；ws 地址随页面协议；第二次换票被拒', async () => {
      const s = await exchangeSession(fetch as never, k.url, k.bootstrapToken)
      expect(s.token).toHaveLength(20)
      expect(s.wsUrl).toBe(k.wsUrl)
      await expect(exchangeSession(fetch as never, k.url, k.bootstrapToken)).rejects.toMatchObject({ name: 'SessionError', status: 401, problemName: 'AUTH_FAILED' })
      expect(SessionError).toBeTypeOf('function')
    })
  })
})

describe('偏好', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

  it('默认值、持久化、URL 参数只在加载时生效不写入记忆', () => {
    const st = mem()
    const a = new PrefsStore(st)
    expect(a.get()).toEqual({ theme: 'deep', density: 'comfortable', nav: 'left', navForm: 'top', updown: 'intl', blockCfg: {} })
    a.set({ nav: 'right', theme: 'graphite' })
    const b = new PrefsStore(st, new URLSearchParams('density=compact&nav=left'))
    expect(b.get()).toEqual({ theme: 'graphite', density: 'compact', nav: 'left', navForm: 'top', updown: 'intl', blockCfg: {} })
    b.set({ theme: 'deep' }) // 只记用户显式改的；URL 覆盖的 nav / density 不写进记忆
    expect(new PrefsStore(st).get()).toEqual({ theme: 'deep', density: 'comfortable', nav: 'right', navForm: 'top', updown: 'intl', blockCfg: {} })
    expect(b.get()).toEqual({ theme: 'deep', density: 'compact', nav: 'left', navForm: 'top', updown: 'intl', blockCfg: {} })
    b.set({ nav: 'right' }) // 用户自己改了这一项，URL 不再覆盖
    expect(b.get().nav).toBe('right')
  })

  it('坏数据与未知值回落默认', () => {
    const st = { getItem: () => '{"theme":"neon","density":3}', setItem: () => {} }
    expect(new PrefsStore(st).get()).toEqual({ theme: 'deep', density: 'comfortable', nav: 'left', navForm: 'top', updown: 'intl', blockCfg: {} })
    expect(new PrefsStore({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }).get().theme).toBe('deep')
  })

  it('视口高 < 760 自动紧凑', () => {
    expect(effectiveDensity('comfortable', 700)).toBe('compact')
    expect(effectiveDensity('comfortable', 900)).toBe('comfortable')
    expect(effectiveDensity('compact', 900)).toBe('compact')
  })
})

describe('谁做的', () => {
  it('优先用内核盖章的 actorType，没有则按前缀推断', () => {
    expect(originActorType({ actor: 'agent:ak_01JAB5', actorType: 'llm-agent' })).toBe('llm-agent')
    expect(originActorType({ actor: 'agent:ak_1' })).toBe('llm-agent')
    expect(originActorType({ actor: 'user:usr_local' })).toBe('human')
    for (const a of ['strategy:ema-trend', 'workflow:wf_1', 'plugin:x', 'engine:core']) expect(originActorType({ actor: a })).toBe('engine')
    for (const a of ['system:protector', 'venue:hyperliquid', 'mandate:mdt_1']) expect(originActorType({ actor: a })).toBe('system')
    expect(originActorType(undefined)).toBe('system')
    expect(originActorType({ actor: 'user:u', actorType: 'engine' })).toBe('engine')
  })
  it('小标形状与来源筛选器', () => {
    expect(actorKind('agent:ak_1')).toBe('host')
    expect(actorKind({ actor: 'strategy:s', actorType: 'engine' })).toBe('unit')
    expect(actorKind('user:u')).toBe('user')
    expect(ACTOR_FILTERS.map((f) => f.label)).toEqual(['全部', '人', '引擎', 'LLM Agent', '系统'])
    const rows = [{ actor: 'user:u', actorType: 'human' }, { actor: 'agent:a', actorType: 'llm-agent' }, { actor: 'strategy:s', actorType: 'engine' }, { actor: 'system:x', actorType: 'system' }]
    expect(rows.filter((r) => matchesActorFilter(r, 'all'))).toHaveLength(4)
    expect(rows.filter((r) => matchesActorFilter(r, 'llm-agent'))).toEqual([rows[1]])
    expect(rows.filter((r) => matchesActorFilter(r, 'human'))).toEqual([rows[0]])
  })
})
