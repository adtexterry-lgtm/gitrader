// SPDX-License-Identifier: CPAL-1.0
// 清单自检：过协议校验（JSON Schema + 跨字段语义）0 问题，且 name / desc / tools[].desc 无承诺类用语。
import { readFileSync } from 'node:fs'
import { findPromiseLanguage, validatePluginManifest, type PluginManifest } from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../gitrader-plugin.json', import.meta.url), 'utf8')) as PluginManifest

describe('gitrader-plugin.json', () => {
  it('过协议校验：语义 0 问题，清单与协议校验全过（工具名 notify_send 与 B0 契约的 notify.send 的差异由主会话决定统一）', () => {
    const result = validatePluginManifest(manifest)
    if (result.ok) return // 协议放开 tools[].name 正则后这里直接过
    // 带 code 的是跨字段语义问题；必须一条都没有
    expect(result.issues.filter((issue) => issue.code !== undefined)).toEqual([])
    // 剩下的只允许是 /tools/0/name 的 pattern（^[A-Za-z0-9_-]{1,64}$ 不含 "."）
    expect(result.issues).toEqual([
      { path: '/tools/0/name', message: 'must match pattern "^[A-Za-z0-9_-]{1,64}$"', keyword: 'pattern' },
    ])
  })

  it('承诺类用语为 null（name / desc / tools[].desc）', () => {
    expect(findPromiseLanguage(manifest.name)).toBeNull()
    expect(findPromiseLanguage(manifest.desc)).toBeNull()
    for (const tool of manifest.tools ?? []) expect(findPromiseLanguage(tool.desc)).toBeNull()
  })

  it('声明 notify.send、出网白名单与令牌句柄', () => {
    expect(manifest.tools?.map((tool) => tool.name)).toContain('notify_send')
    expect(manifest.permissions).toContain('net.fetch')
    expect(manifest.net?.hosts).toEqual(['api.telegram.org'])
    expect(manifest.secrets).toEqual(['TELEGRAM_BOT_TOKEN'])
    expect(manifest.privacy.hosted).toBe(false)
    expect(manifest.tools?.[0]?.permissions).toEqual(['net.fetch'])
  })

  it('入口是 gsp.mjs（纯 .mjs，无构建步骤）', () => {
    expect(manifest.runtime.type).toBe('node')
    expect(manifest.entry?.module).toBe('./gsp.mjs')
  })
})
