// SPDX-License-Identifier: CPAL-1.0
// gitrader plugins check | grant | call：真 CLI 入口 + 临时 home，不 mock 内核。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main, runServe } from '../src/index'
import type { CliIo } from '../src/index'
import { fileProvider, loadConfig, pinPluginDir, saveConfig } from '@gitrader/kernel'

const EMA = resolve(__dirname, '..', '..', 'plugin-template', 'example', 'ema-reading')
const PIN = '482916'

let home: string
let out: string[]
let err: string[]
let secrets: string[]
const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider,
  readSecret: async () => { const s = secrets.shift(); if (s === undefined) throw new Error('unexpected secret prompt'); return s }, ...over,
})
const run = (argv: string[], over: Partial<CliIo> = {}): Promise<number> => main(argv, io(over))
const text = (): string => out.join('')

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-cli-pl-')); out = []; err = []; secrets = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader plugins check', () => {
  it('合格的示例 → 退出 0，末行 ok <id>@<version>；不需要 home 已初始化', async () => {
    expect(await run(['plugins', 'check', EMA])).toBe(0)
    expect(text()).toContain('ok block.example.ema-reading@0.1.0')
  })

  it('坏清单 → 退出 2，每个问题一行 CODE  path  message；--json 可解析且 ok=false；--strict 在前也认得目录', async () => {
    const bad = join(home, 'bad')
    cpSync(EMA, bad, { recursive: true })
    const mf = join(bad, 'gitrader-plugin.json')
    const m = JSON.parse(readFileSync(mf, 'utf8'))
    m.desc = '保证收益的指标块'
    m.compat.pluginSchema = '2'
    writeFileSync(mf, JSON.stringify(m, null, 2))
    expect(await run(['plugins', 'check', bad])).toBe(2)
    expect(text()).toMatch(/^PROMISE_LANGUAGE {2}\/desc {2}/m)
    expect(text()).toContain('COMPAT_SCHEMA_UNSUPPORTED')
    expect(text()).toMatch(/REJECTED \d+ problem\(s\)\n$/)
    out = []
    expect(await run(['plugins', 'check', bad, '--json'])).toBe(2)
    const j = JSON.parse(text())
    expect(j.ok).toBe(false)
    expect(j.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['PROMISE_LANGUAGE', 'COMPAT_SCHEMA_UNSUPPORTED']))
    out = []
    expect(await run(['plugins', 'check', '--strict', bad])).toBe(2)
    expect(text()).toContain('PROMISE_LANGUAGE')
  })

  it('--strict：未签名示例不放行（开发者模式下才放行）', async () => {
    expect(await run(['plugins', 'check', EMA, '--strict'])).toBe(2)
    expect(text()).toContain('UNSIGNED_NOT_ALLOWED')
  })

  it('缺目录参数 → 退出 1', async () => {
    expect(await run(['plugins', 'check'])).toBe(1)
    expect(err.join('')).toMatch(/usage/)
  })
})

const ECHO_JS = `process.stdin.setEncoding('utf8')
let buf = ''
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.method === 'plugin.hello' || m.method === 'plugin.health') reply(m.id, { ok: true })
    else if (m.method === 'plugin.shutdown') { reply(m.id, { ok: true }); setTimeout(() => process.exit(0), 10) }
    else if (m.method === 'tool.call') reply(m.id, m.params.args)
  }
})
`

function installEcho(): string {
  const dir = join(home, 'plugins', 'echo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), ECHO_JS)
  const m = {
    schema: 'gitrader-plugin/1', id: 'skill.test.echo', package: 'skill', kind: 'skill', name: 'echo', desc: 'echoes its arguments', tags: ['test'], version: '0.1.0',
    vendor: { id: 'test', name: 'Test', kind: 'self', verified: false, url: null },
    source: { repo: 'local/echo', commit: 'a'.repeat(40), sha256: 'sha256:' + '0'.repeat(64), fetchedAt: 1 },
    license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'n', commercialUse: true },
    runtime: { type: 'node', node: '22', native: false, diskMB: 1 }, entry: { module: './index.mjs' },
    install: { by: 'user-install', requireHashes: true }, permissions: [], privacy: { hosted: false, sends: [] },
    provides: { tools: ['echo'] },
    tools: [{ name: 'echo', desc: 'echo', tags: ['utility'], input: { type: 'object', required: ['msg'], properties: { msg: { type: 'string' } } } }],
    fixtures: { offline: [], smoke: [] }, compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
  }
  writeFileSync(join(dir, 'gitrader-plugin.json'), JSON.stringify(m, null, 2))
  pinPluginDir(dir)
  return dir
}

describe('gitrader plugins grant / call（离线内核）', () => {
  it('未启用 → call 失败并打印 <code> <name>: <message>；grant（PIN）后 call 回显入参', async () => {
    secrets = [PIN, PIN]
    expect(await run(['init'], { interactive: true })).toBe(0)
    const cfg = loadConfig(home)
    cfg.plugins.developerMode = true
    saveConfig(home, cfg)
    installEcho()

    expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '{"msg":"hi"}'])).toBe(1)
    expect(err.join('')).toMatch(/^2004 MANDATE_LIMIT: .*not enabled/m)

    out = []; err = []; secrets = [PIN]
    expect(await run(['plugins', 'grant', 'skill.test.echo'])).toBe(0)
    expect(text()).toBe('enabled skill.test.echo\n')

    out = []; err = []
    expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '{"msg":"hi"}'])).toBe(0)
    expect(JSON.parse(text())).toEqual({ msg: 'hi' })

    out = []; err = []
    expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '{}'])).toBe(1) // 缺 msg：入参先过清单里的 schema
    expect(err.join('')).toMatch(/^-32602 INVALID_PARAMS: .*msg/m)
    out = []; err = []
    expect(await run(['plugins', 'call', 'skill.test.echo', 'nope'])).toBe(1)
    expect(err.join('')).toMatch(/^5008 PLUGIN_TOOL_UNKNOWN: /m)
  })

  it('args 不是合法 JSON → 退出 1；grant 错 PIN / 未知插件 → 退出 1', async () => {
    secrets = [PIN, PIN]
    await run(['init'], { interactive: true })
    expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '{oops'])).toBe(1)
    expect(err.join('')).toMatch(/not valid JSON/)
    secrets = [PIN]
    err = []
    expect(await run(['plugins', 'grant', 'skill.test.none'])).toBe(1)
    expect(err.join('')).toMatch(/no such plugin/)
  })
})

describe('自检修复', () => {
  async function setup(): Promise<void> {
    secrets = [PIN, PIN]
    await run(['init'], { interactive: true })
    const cfg = loadConfig(home)
    cfg.plugins.developerMode = true
    saveConfig(home, cfg)
    installEcho()
  }

  it('call 入参：@文件 与 - （stdin）；list 显示 enabled:no → grant 后 enabled:yes', async () => {
    await setup()
    expect(await run(['plugins', 'list'])).toBe(0)
    expect(text()).toMatch(/skill\.test\.echo .* enabled:no\n$/)
    secrets = [PIN]
    expect(await run(['plugins', 'grant', 'skill.test.echo'])).toBe(0)
    out = []
    expect(await run(['plugins', 'list'])).toBe(0)
    expect(text()).toMatch(/enabled:yes\n$/)
    const f = join(home, 'args.json')
    writeFileSync(f, '﻿{"msg":"from-file"}')
    out = []
    expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '@' + f])).toBe(0)
    expect(JSON.parse(text())).toEqual({ msg: 'from-file' })
    out = []
    expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '-'], { readStdin: async () => '{"msg":"from-stdin"}' })).toBe(0)
    expect(JSON.parse(text())).toEqual({ msg: 'from-stdin' })
    err = []
    expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '@' + join(home, 'missing.json')])).toBe(1)
    expect(err.join('')).toMatch(/cannot read args/)
  })

  it('离线 grant 错误带码：永不可授予的权限 → 2004 MANDATE_LIMIT', async () => {
    await setup()
    secrets = [PIN]
    expect(await run(['plugins', 'grant', 'skill.test.echo', 'withdraw'])).toBe(1)
    expect(err.join('')).toMatch(/^2004 MANDATE_LIMIT: permission withdraw can never be granted$/m)
  })

  it('非交互 init：明说 PIN 没设；交互设了 PIN 就不说', async () => {
    expect(await run(['init'])).toBe(0)
    // fix-r4: 非交互 init 的提示文案改为中文「PIN 未设置：…」（不再含英文 PIN not set，也不再说“请之后在终端里运行”）
    expect(text()).toContain('PIN 未设置')
    out = []
    secrets = [PIN, PIN]
    expect(await run(['init'], { interactive: true })).toBe(0)
    // fix-r4: 同上，字面量随提示文案更新
    expect(text()).not.toContain('PIN 未设置')
    out = []
    expect(await run(['init'])).toBe(0) // PIN 已设：非交互再跑也不说
    // fix-r4: 同上，字面量随提示文案更新
    expect(text()).not.toContain('PIN 未设置')
  })
})

describe('gitrader plugins call（服务在跑）', () => {
  it('走服务的 plugin.call：插件还没起 → CLI 经 plugin.start 拉起后再调；回显入参', async () => {
    secrets = [PIN, PIN]
    await run(['init'], { interactive: true })
    const cfg = loadConfig(home)
    cfg.plugins.developerMode = true
    saveConfig(home, cfg)
    installEcho()
    secrets = [PIN]
    expect(await run(['plugins', 'grant', 'skill.test.echo'])).toBe(0) // 服务没起：离线内核
    out = []
    const h = await runServe(home, { io: io(), connectors: false })
    try {
      secrets = [h.kernel.auth.mintBootToken()]
      expect(await run(['session', 'login'])).toBe(0)
      out = []; err = []; secrets = []
      expect(await run(['plugins', 'call', 'skill.test.echo', 'echo', '{"msg":"x"}'])).toBe(0)
      expect(JSON.parse(text())).toEqual({ msg: 'x' })
      out = []; err = []
      expect(await run(['plugins', 'grant', 'skill.test.echo'])).toBe(1) // 服务在跑：不发 plugin.grant，直接提示
      expect(err.join('')).toContain('service is running')
    } finally { await h.kernel.plugins.stopAll(); await h.stop() }
  })
})
