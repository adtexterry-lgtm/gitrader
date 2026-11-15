// SPDX-License-Identifier: CPAL-1.0
// 清单自检：过协议校验（JSON Schema + 跨字段语义）0 问题，且 name / desc / tools[].desc 无承诺类用语。
import { readFileSync } from 'node:fs'
import { findPromiseLanguage, validatePluginManifest, type PluginManifest } from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../gitrader-plugin.json', import.meta.url), 'utf8')) as PluginManifest

describe('gitrader-plugin.json（Slack）', () => {
  it('过协议校验：0 问题（工具名 notify_send 是协议合法名）', () => {
    const result = validatePluginManifest(manifest)
    if (!result.ok) expect(result.issues).toEqual([])
  })

  it('承诺类用语为 null（name / desc / tools[].desc）', () => {
    expect(findPromiseLanguage(manifest.name)).toBeNull()
    expect(findPromiseLanguage(manifest.desc)).toBeNull()
    for (const tool of manifest.tools ?? []) expect(findPromiseLanguage(tool.desc)).toBeNull()
  })

  it('声明 notify_send、出网白名单 hooks.slack.com 与 webhook 句柄', () => {
    expect(manifest.tools?.map((tool) => tool.name)).toContain('notify_send')
    expect(manifest.permissions).toContain('net.fetch')
    expect(manifest.net?.hosts).toEqual(['hooks.slack.com'])
    expect(manifest.secrets).toEqual(['SLACK_WEBHOOK_URL'])
    expect(manifest.privacy.hosted).toBe(false)
    expect(manifest.tools?.[0]?.permissions).toEqual(['net.fetch'])
    const channels = (manifest.provides as { channels?: Array<{ tool?: string; platform?: string }> }).channels
    expect(channels?.[0]).toMatchObject({ tool: 'notify_send', platform: 'slack' })
  })

  it('入口是 gsp.mjs（纯 .mjs，无构建步骤）；risk 写明 webhook 是凭据', () => {
    expect(manifest.runtime.type).toBe('node')
    expect(manifest.entry?.module).toBe('./gsp.mjs')
    expect(manifest.risk?.disclosure ?? '').toContain('hooks.slack.com')
    expect(manifest.risk?.disclosure ?? '').toContain('凭据')
  })
})
