// SPDX-License-Identifier: CPAL-1.0
// 清单自检：过协议校验（JSON Schema + 跨字段语义）0 问题；工具名 notify_send；出网白名单只有一个官方域名；
// secrets 只有 webhook 地址一项；privacy.hosted=false；name / desc / tools[].desc 无承诺类用语。
import { readFileSync } from 'node:fs'
import { findPromiseLanguage, validatePluginManifest, type PluginManifest } from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../gitrader-plugin.json', import.meta.url), 'utf8')) as PluginManifest

describe('gitrader-plugin.json', () => {
  it('过协议校验：0 问题', () => {
    const result = validatePluginManifest(manifest)
    // 失败时把问题打出来（比只看 ok=false 有用）
    if (!result.ok) console.error(result.issues)
    expect(result.ok).toBe(true)
  })

  it('声明 notify_send、只出网到 qyapi.weixin.qq.com、密钥只有 WECOM_WEBHOOK_URL', () => {
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(['notify_send'])
    expect(manifest.permissions).toEqual(['net.fetch'])
    expect(manifest.net?.hosts).toEqual(['qyapi.weixin.qq.com'])
    expect(manifest.secrets).toEqual(['WECOM_WEBHOOK_URL'])
    expect(manifest.tools?.[0]?.permissions).toEqual(['net.fetch'])
  })

  it('通道声明为 wecom，隐私面：不托管、sends 为空（通知正文不属于协议枚举的四类数据）', () => {
    expect(manifest.provides.channels).toEqual([{ tool: 'notify_send', platform: 'wecom' }])
    expect(manifest.privacy.hosted).toBe(false)
    expect(manifest.privacy.sends).toEqual([])
  })

  it('入口是 gsp.mjs（纯 .mjs，无构建步骤）', () => {
    expect(manifest.runtime.type).toBe('node')
    expect(manifest.entry?.module).toBe('./gsp.mjs')
  })

  it('承诺类用语为 null（name / desc / tools[].desc / risk）', () => {
    expect(findPromiseLanguage(manifest.name)).toBeNull()
    expect(findPromiseLanguage(manifest.desc)).toBeNull()
    for (const tool of manifest.tools ?? []) expect(findPromiseLanguage(tool.desc)).toBeNull()
    expect(findPromiseLanguage(manifest.risk?.disclosure ?? '')).toBeNull()
    expect(findPromiseLanguage(manifest.risk?.worstCase ?? '')).toBeNull()
  })

  // 批 11 主题二 ⑤：通知契约以 docs/notifications.md 为唯一真源，input.required 一律是 notice + params。
  // 旧用例断言「wecom 不读 params，所以不要求必填」——那是按通道的用处定契约；现在按文档定契约：
  // 内核总会发 params（内核配置校验要求 notify.channels[].params 必须是对象），通道读不读是通道自己的事。
  it('输入必填 notice + params（与 docs/notifications.md 的工具契约一致），notice 必填', () => {
    const input = manifest.tools?.[0]?.input as { required?: string[]; properties?: Record<string, unknown> }
    expect(input.required).toEqual(['notice', 'params'])
    expect(Object.keys(input.properties ?? {})).toEqual(['notice', 'params'])
  })
})
