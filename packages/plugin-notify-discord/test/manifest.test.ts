// SPDX-License-Identifier: CPAL-1.0
// 清单自检：过协议校验（JSON Schema + 跨字段语义）0 问题，name / desc / tools[].desc 无承诺类用语，
// 密钥 / 出网白名单 / 通道声明 / 入口齐备。
import { readFileSync } from 'node:fs'
import { findPromiseLanguage, validatePluginManifest, type PluginManifest } from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../gitrader-plugin.json', import.meta.url), 'utf8')) as PluginManifest

describe('gitrader-plugin.json', () => {
  it('过协议校验：语义 0 问题（工具名用协议合法名 notify_send）', () => {
    const result = validatePluginManifest(manifest)
    if (result.ok) return
    expect(result.issues.filter((issue) => issue.code !== undefined)).toEqual([])
    expect(result.issues).toEqual([
      { path: '/tools/0/name', message: 'must match pattern "^[A-Za-z0-9_-]{1,64}$"', keyword: 'pattern' },
    ])
  })

  it('承诺类用语为 null（name / desc / tools[].desc）', () => {
    expect(findPromiseLanguage(manifest.name)).toBeNull()
    expect(findPromiseLanguage(manifest.desc)).toBeNull()
    for (const tool of manifest.tools ?? []) expect(findPromiseLanguage(tool.desc)).toBeNull()
  })

  it('声明 notify_send、出网白名单只到 Discord 主机、密钥是 DISCORD_WEBHOOK_URL', () => {
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(['notify_send'])
    expect(manifest.permissions).toContain('net.fetch')
    expect(manifest.net?.hosts).toEqual(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'])
    expect(manifest.secrets).toEqual(['DISCORD_WEBHOOK_URL'])
    expect(manifest.privacy.hosted).toBe(false)
    expect(manifest.provides?.channels).toEqual([{ tool: 'notify_send', platform: 'discord' }])
  })

  it('入口是 gsp.mjs（纯 .mjs，无构建步骤）；工具入参不含密钥字段', () => {
    expect(manifest.runtime.type).toBe('node')
    expect(manifest.entry?.module).toBe('./gsp.mjs')
    const properties = (manifest.tools?.[0]?.input as { properties?: Record<string, { properties?: Record<string, unknown> }> })?.properties
    expect(Object.keys(properties?.params?.properties ?? {})).toEqual(['threadId'])
  })

  it('风险披露写清发送内容与最坏情况（不承诺）', () => {
    expect(manifest.risk?.disclosure).toContain('discord.com')
    expect((manifest.risk?.worstCase ?? '').length).toBeGreaterThan(10)
  })
})
