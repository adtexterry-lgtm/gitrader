// SPDX-License-Identifier: CPAL-1.0
// 清单测试：过协议校验（schema + 语义规则 0 问题）、零承诺语言、网络权限与密钥声明、工具 schema 收 B0 的入参。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkPluginManifestIssues,
  compileSchema,
  findPromiseLanguage,
  validatePluginManifest,
  type PluginManifest,
} from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'

const dir = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(dir, 'gitrader-plugin.json'), 'utf8')) as PluginManifest

/** B0 契约里内核发出的 input 形状。 */
const SAMPLE = {
  notice: {
    key: 'risk.denials:acct_x:ruleY',
    level: 'warn',
    title: 'Risk denial',
    lines: ['account acct_x', 'rule Y', 'notional 1200 > 1000'],
    ts: 1760000000000,
    topic: 'risk.denials',
  },
  params: { host: 'localhost', port: 2525, secure: false, from: 'bot@localhost', to: ['ops@localhost'] },
}

describe('gitrader-plugin.json', () => {
  it('过协议校验：validatePluginManifest ok 且语义问题 0 条', () => {
    const result = validatePluginManifest(manifest)
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true)
    expect(checkPluginManifestIssues(manifest)).toEqual([])
  })

  it('name / desc / tools[].desc 没有承诺类语言', () => {
    expect(findPromiseLanguage(manifest.name)).toBeNull()
    expect(findPromiseLanguage(manifest.desc)).toBeNull()
    for (const tool of manifest.tools ?? []) expect(findPromiseLanguage(tool.desc)).toBeNull()
  })

  it('声明 notify_send（B0 的 notify.send 在协议工具名里不允许点号）、net.fetch 与 net.hosts、secrets 只有 SMTP_PASSWORD', () => {
    expect(manifest.kind).toBe('connector')
    expect(manifest.permissions).toEqual(['net.fetch'])
    expect(manifest.net?.hosts.length).toBeGreaterThan(0)
    expect(manifest.secrets).toEqual(['SMTP_PASSWORD'])
    expect(manifest.provides['channels']).toEqual([{ tool: 'notify_send', platform: 'smtp' }])
    expect((manifest.tools ?? []).map((t) => t.name)).toEqual(['notify_send'])
    expect(manifest.entry).toMatchObject({ module: './gsp.mjs', transport: 'stdio' })
  })

  it('工具 input 能编译，且收得下 B0 的 { notice, params }；output 收得下成功与失败两种应答', () => {
    const tool = (manifest.tools ?? [])[0]
    expect(tool).toBeDefined()
    const input = compileSchema(tool!.input as Record<string, unknown>)
    expect(input(SAMPLE).ok).toBe(true)
    expect(input({ notice: SAMPLE.notice }).ok).toBe(false)

    const output = compileSchema(tool!.output as Record<string, unknown>)
    expect(output({ ok: true, ref: '<id@host>' }).ok).toBe(true)
    expect(output({ ok: false, reason: 'SMTP RCPT TO failed: 550 5.1.1 mailbox unavailable', retryable: false }).ok).toBe(true)
  })

  it('params 声明了 host / port / secure / user / from / to / subjectPrefix', () => {
    const tool = (manifest.tools ?? [])[0]
    const params = ((tool!.input as Record<string, unknown>)['properties'] as Record<string, Record<string, unknown>>)['params']!
    expect(Object.keys(params['properties'] as Record<string, unknown>).sort()).toEqual(
      ['from', 'host', 'port', 'secure', 'subjectPrefix', 'to', 'user'],
    )
    expect(params['required']).toEqual(['host', 'from', 'to'])
  })
})

describe('打包元数据（L5-13）', () => {
  it('entry.module 与 package.json exports 对齐：./gsp 指向 ./gsp.mjs，且不声明运行时依赖', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      exports?: Record<string, string>
      dependencies?: Record<string, string>
    }
    expect(manifest.entry?.module).toBe('./gsp.mjs')
    expect(pkg.exports?.['./gsp']).toBe('./gsp.mjs')
    expect(pkg.dependencies).toBeUndefined()
  })
})
