// SPDX-License-Identifier: CPAL-1.0
// integrations/ 下的接入材料：SKILL 长度（契约 §5.7：主文件 ≤ 1,500 token）、禁词、不含令牌、配方形状（与 UNIGIT 配方门禁同口径的静态检查）。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MCP_BUDGET, MCP_TOOLS, MCP_TOOL_NAMES, estimateTokens } from '@gitrader/protocol'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'integrations')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
const files = (dir = root): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p] })

describe('SKILL.md', () => {
  const main = read('SKILL.md')
  const unigit = read('unigit/official.gitrader/SKILL.md')

  it('主文件 ≤ 1,500 token（估算），有 frontmatter', () => {
    expect(estimateTokens(main)).toBeLessThanOrEqual(MCP_BUDGET.maxSkillMdTokens)
    expect(main.startsWith('---')).toBe(true)
    expect(main).toMatch(/^name: gitrader$/m)
    expect(main).toMatch(/^description: \S/m)
  })

  it('写明：不做交易判断、默认纸面、提案要人批、被拒不重试、不可信输入', () => {
    for (const s of [main, unigit]) {
      expect(s).toMatch(/不做交易判断/)
      expect(s).toMatch(/默认纸面/)
      expect(s).toMatch(/提案/)
      expect(s).toMatch(/批准/)
      expect(s).toMatch(/不换参数重试/)
      expect(s).toMatch(/不可信输入/)
      expect(s).toMatch(/默认被策略拒绝/)
    }
  })

  it('内部宿主技能 ≤ 2000 字符，正文不出现 MCP / stdio / Python / 内部标识（配方门禁规则），frontmatter 有 name 与 description', () => {
    expect(unigit.length).toBeLessThanOrEqual(2000)
    expect(unigit.startsWith('---')).toBe(true)
    const head = unigit.split('---')[1] ?? ''
    expect(head).toMatch(/^\s*name:\s*\S/m)
    expect(head).toMatch(/^\s*description:\s*\S/m)
    expect(unigit.replace(/mcp__[a-z0-9-]+__/g, '')).not.toMatch(/\b(MCP|stdio|Python)\b/)
  })

  it('反引号里写的名字都是真实存在的工具名或动作名', () => {
    const known = new Set<string>([...MCP_TOOL_NAMES, ...MCP_TOOLS.flatMap((t) => t.actions.map((x) => x.name))])
    const mentioned = [...(main + unigit).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!)
    expect(mentioned.length).toBeGreaterThan(5)
    for (const n of mentioned) expect(known.has(n), n).toBe(true)
  })
})

describe('UNIGIT 配方', () => {
  const app = JSON.parse(read('unigit/official.gitrader.json')) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const mcp = JSON.parse(read('unigit/official.gitrader-mcp.json')) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

  it('形状：schema / id / kind / 平台 / 信任 / 依赖', () => {
    expect(app).toMatchObject({ schema: 'unigit-recipe/1', id: 'official.gitrader', kind: 'app', platform: 'win32-x64', trust: 'official-catalog', dependencies: ['official.gitrader-mcp'] })
    expect(mcp).toMatchObject({ schema: 'unigit-recipe/1', id: 'official.gitrader-mcp', kind: 'mcp-tool', platform: 'win32-x64', trust: 'official-catalog' })
    expect(mcp.mcp.serverName).toBe('gitrader')
    expect(mcp.mcp.command).toBe('{node}')
    expect(mcp.runtime.requires).toContain('node-bundled')
    expect(app.runtime.requires).toContain('node-bundled')
    expect(mcp.mcp.toolCallTimeoutMs).toBeGreaterThanOrEqual(1000)
  })

  it('app：launch / health / embed 只指向本机；tagline ≤ 24 字；highlights 2–3 条；skill 指向存在的文件', () => {
    expect(app.launch.exec).toBe('{node}')
    expect(app.launch.args).toEqual(expect.arrayContaining(['serve', '--port', '{port:http}', '--home', '{dataDir}']))
    expect(app.health.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(app.embed).toMatchObject({ kind: 'iframe' })
    expect(app.embed.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect([...app.tagline].length).toBeLessThanOrEqual(24)
    expect(app.highlights.length).toBeGreaterThanOrEqual(2)
    expect(app.highlights.length).toBeLessThanOrEqual(3)
    expect(existsSync(join(root, 'unigit', app.skill))).toBe(true)
    expect(app.gatewayToken).toBeUndefined() // Gitrader 本身不调模型，不需要网关令牌
  })

  it('source 的 size / sha256 是真实值（由 pack.mjs 回填）；本地 zip 在就必须与之一致', () => {
    for (const r of [app, mcp]) {
      expect(r.source.url).toMatch(/^https:\/\//)
      expect(r.source.size).toBeGreaterThan(0)
      expect(r.source.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(r.source.sha256).not.toBe('0'.repeat(64))
      const zip = join(root, '..', 'dist-store', String(r.source.url).split('/').pop() ?? '')
      if (existsSync(zip)) {
        const buf = readFileSync(zip)
        expect(buf.length, zip).toBe(r.source.size)
        expect(createHash('sha256').update(buf).digest('hex'), zip).toBe(r.source.sha256)
      }
    }
  })

  it('zip 布局约定：app 用 bin.js，MCP 用 gitrader-mcp.js；MCP 的宿主调用时限 ≥ 下单类的 90 秒', () => {
    expect(app.launch.args[0]).toBe('{installDir}/bin.js')
    expect(mcp.mcp.args).toEqual(['{installDir}/gitrader-mcp.js'])
    expect(mcp.mcp.toolCallTimeoutMs).toBeGreaterThanOrEqual(100_000)
  })

  it('展示图：icon / cover / hero / screens 都在，尺寸与大小符合商店门禁（icon svg ≤64KB；cover 16:9 ≤300KB；hero 1280×720 ≤300KB；screens 3–5 张 1600×1000 ≤200KB）', () => {
    const dim = (p: string): { w: number; h: number } => { const b = readFileSync(join(root, 'unigit', p)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }
    const size = (p: string): number => statSync(join(root, 'unigit', p)).size
    expect(size(app.icon)).toBeLessThanOrEqual(64 * 1024)
    expect(readFileSync(join(root, 'unigit', app.icon), 'utf8')).toContain('<svg')
    const cover = dim(app.cover)
    expect(cover.w * 9).toBe(cover.h * 16)
    expect(size(app.cover)).toBeLessThanOrEqual(300 * 1024)
    expect(dim(app.showcase.hero)).toEqual({ w: 1280, h: 720 })
    expect(size(app.showcase.hero)).toBeLessThanOrEqual(300 * 1024)
    expect(app.showcase.screens.length).toBeGreaterThanOrEqual(3)
    expect(app.showcase.screens.length).toBeLessThanOrEqual(5)
    for (const sc of app.showcase.screens) {
      expect(dim(sc.file), sc.file).toEqual({ w: 1600, h: 1000 })
      expect(size(sc.file), sc.file).toBeLessThanOrEqual(200 * 1024)
      expect([...sc.title].length).toBeLessThanOrEqual(14)
    }
    expect([...app.showcase.subtitle].length).toBeLessThanOrEqual(16)
    expect(app.showcase.highlights.length).toBeGreaterThanOrEqual(3)
    for (const h of app.showcase.highlights) { expect([...h.title].length).toBeLessThanOrEqual(8); expect([...h.text].length).toBeLessThanOrEqual(30) }
    expect(app.showcase.scenarios.length).toBeGreaterThanOrEqual(2)
    expect(app.showcase.runs).toBe('local-online')
    // 展示文案不得含内部标识词（门禁同口径）
    expect(JSON.stringify(app.showcase)).not.toMatch(/unigit-|sha256|MCP|stdio|localhost|127\.0\.0\.1|https?:\/\//i)
  })

  it('MCP 配方：令牌只经文件，路径指向兄弟目录；env 里没有令牌明文', () => {
    expect(mcp.mcp.env).toEqual({ GITRADER_HOME: '{dataDir}/../official.gitrader', GITRADER_AGENT_TOKEN_FILE: '{dataDir}/../official.gitrader/agent-unigit.token' })
    expect(JSON.stringify(mcp)).not.toMatch(/gtk_[A-Z2-7]{10,}/)
  })
})

describe('integrations/ 整体', () => {
  it('不含令牌样式字符串、邮箱、IP 以外的 127.0.0.1、禁词', () => {
    for (const f of files().filter((x) => !/.png$/.test(x))) {
      const t = readFileSync(f, 'utf8')
      expect(t, f).not.toMatch(/gtk_[A-Z2-7]{10,}|svc_[A-Za-z0-9]{8,}|boot_[A-Za-z0-9]{8,}/)
      expect(t, f).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
      expect(t, f).not.toMatch(/\b(?!127\.0\.0\.1)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
      expect(t, f).not.toMatch(/Comfy|WalletConnect|保守|激进|稳赚|跑赢/)
    }
  })

  it('四个宿主目录都在，且各有说明', () => {
    for (const h of ['unigit', 'claude-code', 'codex', 'hermes']) expect(existsSync(join(root, h, 'README.md')), h).toBe(true)
  })
})
