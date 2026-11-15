// SPDX-License-Identifier: CPAL-1.0
// 清单：gitrader-plugin/1 协议校验（JSON Schema + 跨字段规则）、承诺语言自检、权限 / 主机 / 密钥声明、
// 工具入参出参与 B0 契约一致、目录里的入口文件真实存在。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkPluginManifest, compileSchema, findPromiseLanguage, validatePluginManifest, type PluginManifest } from '@gitrader/protocol'
import { describe, expect, it } from 'vitest'

const dir = resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(dir, 'gitrader-plugin.json'), 'utf8')) as PluginManifest
const tool = manifest.tools?.[0]
const input = tool!.input
const output = tool!.output!

describe('gitrader-plugin/1 清单', () => {
  it('过协议校验（JSON Schema + 跨字段语义规则），0 问题', () => {
    const result = validatePluginManifest(manifest)
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true)
    expect(checkPluginManifest(manifest)).toEqual([])
  })

  it('name / desc / tools[].desc 不含承诺语言', () => {
    expect(findPromiseLanguage(manifest.name)).toBeNull()
    expect(findPromiseLanguage(manifest.desc)).toBeNull()
    for (const item of manifest.tools ?? []) expect(findPromiseLanguage(item.desc)).toBeNull()
    expect(findPromiseLanguage(manifest.risk?.disclosure ?? '')).toBeNull()
  })

  it('声明 net.fetch 与五个平台主机；generic 的主机来自用户配置（不在清单里）', () => {
    expect(manifest.permissions).toEqual(['net.fetch'])
    expect(manifest.net?.hosts).toEqual([
      'open.feishu.cn',
      'oapi.dingtalk.com',
      'qyapi.weixin.qq.com',
      'hooks.slack.com',
      'discord.com',
    ])
    expect(manifest.net?.hosts).not.toContain('*')
  })

  it('密钥只声明名字（WEBHOOK_SECRET），清单里没有密钥值', () => {
    expect(manifest.secrets).toEqual(['WEBHOOK_SECRET'])
    const text = readFileSync(join(dir, 'gitrader-plugin.json'), 'utf8')
    expect(text).not.toMatch(/(?:token|secret)\s*[:=]\s*["'][A-Za-z0-9_-]{12,}/i)
  })

  it('工具是 notify.send（清单里按协议工具名正则写作 notify_send），入参出参符合 B0 的 JSON Schema', () => {
    expect(tool?.name).toBe('notify_send')
    expect(manifest.provides).toMatchObject({ channels: [{ tool: 'notify_send', platform: 'webhook' }] })
    // 清单与运行时能力一致：不再声明 notify.send 别名（L5-10）
    expect(JSON.stringify(manifest.provides)).not.toContain('notify.send')
    expect(input.required).toEqual(['notice', 'params'])
    expect(compileSchema(input)({
      notice: { key: 'risk.denials:acct_x:ruleY', level: 'warn', title: 'Risk denial', lines: ['a'], ts: 1760000000000, topic: 'risk.denials' },
      params: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', markdown: true },
    }).ok).toBe(true)
    expect(compileSchema(input)({
      notice: { key: 'k', level: 'info', title: 't', lines: [] },
    }).ok).toBe(false)
    expect(compileSchema(input)({ notice: { key: 'k', level: 'nope', title: 't', lines: [] } }).ok).toBe(false)
    expect(compileSchema(input)({ notice: { key: 'k', level: 'info', title: 't', lines: [] }, params: { url: 'x' } }).ok).toBe(true)
    expect(compileSchema(output)({ ok: true, ref: 'x' }).ok).toBe(true)
    expect(compileSchema(output)({ ok: false, reason: 'http_500', retryable: true }).ok).toBe(true)
    expect(compileSchema(output)({ ok: false, reason: 'http_500' }).ok).toBe(false)
    expect(tool?.permissions).toEqual(['net.fetch'])
  })

  it('入口文件在目录里：index.mjs / gsp.mjs / webhook.mjs；入口指向 gsp.mjs；运行时零依赖', () => {
    expect(manifest.entry?.module).toBe('./gsp.mjs')
    for (const file of ['index.mjs', 'gsp.mjs', 'webhook.mjs', 'run-conformance.mjs', 'gitrader-plugin.json', 'LICENSE', 'README.md']) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
  })

  // 维护者 裁定（批 11 主题二 ③）：运行时零依赖必须严格，devDependencies 允许。
  // 口径：dependencies / peerDependencies / optionalDependencies 未声明或为空对象（三者都是安装期即装的运行时面）；
  //      devDependencies（vitest 之类的开发工具）不限制——原用例断言 devDependencies 必须 undefined，是把开发依赖也当违规，与本裁定相反。
  it('运行时零依赖：dependencies / peer / optional 都必须为空或未声明（devDependencies 允许）', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      bundledDependencies?: string[] | boolean
    }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([])
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([])
    expect(pkg.bundledDependencies ?? []).toEqual([])
  })

  it('运行时源码不 import 任何裸包名（只允许 node: 内置与相对路径）', () => {
    const offenders: string[] = []
    for (const file of ['index.mjs', 'gsp.mjs', 'webhook.mjs']) {
      const text = readFileSync(join(dir, file), 'utf8')
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = m[1]!
        if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('data:')) continue
        offenders.push(`${file}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('打包元数据（L5-13）', () => {
  it('entry.module 与 package.json exports 对齐：./gsp 指向 ./gsp.mjs', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, string> }
    expect(manifest.entry?.module).toBe('./gsp.mjs')
    expect(pkg.exports?.['./gsp']).toBe('./gsp.mjs')
  })
})
