// SPDX-License-Identifier: CPAL-1.0
// R-50：吊销后署名保留——活动流 / 持仓开仓方仍显示「名字（已撤销）」，名字映射不得依赖 keyTiers（它滤掉吊销的钥匙）。
import { describe, expect, it } from 'vitest'
import { actorNames, keyTiers } from '../src/model-activity'

const raw = {
  keys: [
    { keyId: 'key_01', name: 'Claude Code', status: 'active' },
    { keyId: 'key_02', name: 'Hermes', status: 'revoked' },
  ],
}

describe('名字映射（含已撤销）', () => {
  it('revoked key keeps its name with a suffix', () => {
    expect(actorNames(raw)).toEqual({ 'agent:key_01': 'Claude Code', 'agent:key_02': 'Hermes（已撤销）' })
    // 档位仍只列有效钥匙（吊销的不进 Agent 卡主列表）
    expect(keyTiers(raw, []).map((k) => k.keyId)).toEqual(['key_01'])
  })
  it('active key name unchanged', () => {
    expect(actorNames(raw)['agent:key_01']).toBe('Claude Code')
    expect(actorNames(raw)['agent:key_01']).not.toContain('已撤销')
  })
  it('unknown actor falls back as before', () => {
    // 映射里没有的 actor → 界面照旧退回「LLM Agent」
    expect(actorNames(raw)['agent:key_zz']).toBeUndefined()
    // 缺 keyId / 名字的条目不入映射（不造名字）
    expect(actorNames({ keys: [{ name: '无名' }, { keyId: 'key_03' }, 7] })).toEqual({})
    expect(actorNames(undefined)).toEqual({})
  })
})
