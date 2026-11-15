// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复 A 包（ux-011）：K1 启动器名、K3 CLI 语言，以及 UX-01 / 05 / 07 / 08 / 12 / 13 / 16 / 17 / 18 / 19 / 26 / 28 的 CLI 部分。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kernel, fileProvider, initHome, KERNEL_VERSION } from '@gitrader/kernel'
import { announceServe, main, runServe } from '../src/index'
import type { CliIo } from '../src/index'
import { doctorDeps, runChecks } from '../src/doctor'
import { cmdName, fmtLocal, resolveLang } from '../src/lang'
import { bootTokenFrom } from '../src/session'
import { cmdServeDetach } from '../src/serve-detach'
import { renderSnippet } from '../src/snippets'

const CJK = /[一-龥]/
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

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-ux-a-')); out = []; err = []; secrets = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('K3 语言取值与 K1 启动器名', () => {
  it('--lang → GITRADER_LANG → 系统 locale', () => {
    expect(resolveLang('en', { GITRADER_LANG: 'zh' })).toBe('en')
    expect(resolveLang(undefined, { GITRADER_LANG: 'en' })).toBe('en')
    expect(resolveLang(undefined, { GITRADER_LANG: 'zh-CN' })).toBe('zh')
    expect(resolveLang('fr', { GITRADER_LANG: 'en' })).toBe('en') // 不认识的值当没给
  })

  it('cmdName：没设 = gitrader；设了用它；路径含空格加双引号', () => {
    expect(cmdName({})).toBe('gitrader')
    expect(cmdName({ GITRADER_LAUNCHER: 'C:\\pkg\\bin\\gitrader.cmd' })).toBe('C:\\pkg\\bin\\gitrader.cmd')
    expect(cmdName({ GITRADER_LAUNCHER: 'C:\\my pkg\\bin\\gitrader.cmd' })).toBe('"C:\\my pkg\\bin\\gitrader.cmd"')
  })

  it('设了 GITRADER_LAUNCHER：「下一步」命令用启动器名；JSON 输出里的 next 也是', async () => {
    const env = { GITRADER_HOME: home, GITRADER_LAUNCHER: 'C:\\my pkg\\gitrader.cmd', GITRADER_LANG: 'zh' }
    expect(await run(['status'], { env })).toBe(0)
    expect(text()).toContain('下一步："C:\\my pkg\\gitrader.cmd" init')
    expect(text()).not.toMatch(/(^|[\s：])gitrader init/)
    out = []
    expect(await run(['status', '--json'], { env })).toBe(0)
    expect(JSON.parse(text()).next).toBe('"C:\\my pkg\\gitrader.cmd" init')
    out = []
    expect(await run(['init', '--no-pin'], { env })).toBe(0)
    expect(text()).toContain('下一步："C:\\my pkg\\gitrader.cmd" serve')
  })
})

describe('K3 英文输出：首次运行用到的命令不再冒中文', () => {
  const en = { GITRADER_LANG: 'en' }
  it('help 顶部有四行快速开始，整屏没有中文，没有内部字样 bench / M1', async () => {
    expect(await run(['--help'], { env: { GITRADER_HOME: home, ...en } })).toBe(0)
    const t = text()
    expect(t).toContain('Quick start')
    expect(t).not.toMatch(CJK)
    expect(t).not.toMatch(/gitrader bench|stub in M1/)
    expect(t.indexOf('gitrader init')).toBeLessThan(t.indexOf('gitrader reconcile'))
  })

  it('--lang en 优先于 GITRADER_LANG=zh；init / status / open / doctor 都是英文', async () => {
    const e = { GITRADER_HOME: home, GITRADER_LANG: 'zh' }
    expect(await run(['status', '--lang', 'en'], { env: e })).toBe(0)
    expect(text()).toContain('Not initialized yet')
    expect(text()).not.toMatch(CJK)
    out = []
    expect(await run(['init', '--no-pin', '--lang', 'en'], { env: e })).toBe(0)
    expect(text()).toContain('Created the Gitrader directory')
    expect(text()).not.toMatch(CJK)
    out = []
    expect(await run(['init', '--no-pin', '--lang', 'en'], { env: e })).toBe(0)
    expect(text()).toContain('Already initialized')
    expect(text()).not.toMatch(CJK)
    expect(text().match(/Next:/g)?.length).toBe(1) // UX-18：不重复
    expect(await run(['open', '--print', '--lang', 'en'], { env: e })).toBe(1)
    expect(err.join('')).toContain('No running Gitrader service for this home. Start it with: gitrader serve')
    expect(err.join('')).not.toMatch(CJK)
    err = []
    expect(await run(['session', 'login', '--lang', 'en'], { env: e })).toBe(1)
    expect(err.join('')).toContain('Start the local service first with: gitrader serve')
  })

  it('同样的命令在中文下是中文，且 open 的「没有服务」报错中文后括号英文（UX-17）', async () => {
    expect(await run(['open', '--print'])).toBe(1)
    expect(err.join('')).toContain('没有在运行的服务（No running Gitrader service for this home）')
    err = []
    expect(await run(['session', 'login'])).toBe(1)
    expect(err.join('')).toContain('没有在运行的服务')
    expect(await run(['engines', 'list'])).toBe(1)
    expect(err.join('')).toContain('没有在运行的服务')
  })

  it('doctor：英文界面整屏英文（含 → Next:），中文界面不变', async () => {
    const saved = { ...doctorDeps }
    Object.assign(doctorDeps, { liveService: async () => null, mcpEntry: () => ({ path: fileURLToPath(import.meta.url), built: true }), staticDir: () => tmpdir(), verifyLedgerOffline: () => ({ ok: true, count: 0 }) })
    try {
      initHome(home)
      expect(await run(['doctor', '--lang', 'en'])).toBe(1)
      const t = text()
      expect(t).toContain('No PIN yet')
      expect(t).toContain('→ Next:')
      expect(t).not.toMatch(CJK)
      out = []
      expect(await run(['doctor', '--lang', 'zh'])).toBe(1)
      expect(text()).toContain('还没设 PIN')
    } finally { Object.assign(doctorDeps, saved) }
  })

  it('serve 起来的提示：英文界面不带中文；--open 会调用打开浏览器', () => {
    const opened: string[] = []
    announceServe(io({ lang: 'en', openUrl: (u) => opened.push(u) }), { port: 47900, url: 'http://127.0.0.1:47900/?launch=boot_x' }, true)
    expect(text()).toContain('is running on 127.0.0.1:47900')
    expect(text()).not.toMatch(CJK)
    expect(opened).toEqual(['http://127.0.0.1:47900/?launch=boot_x'])
    opened.length = 0
    announceServe(io({ lang: 'en', openUrl: (u) => opened.push(u) }), { port: 47900, url: 'http://x/' }, false)
    expect(opened).toEqual([])
  })
})

describe('UX-26 / UX-16 帮助', () => {
  it('不带参数等同 help：退出码 0', async () => {
    expect(await run([])).toBe(0)
    expect(text()).toContain('gitrader init')
  })

  it('中文 help 顶部有快速开始、分组标题，没有 bench 行；keys new agent --help 只打这一条', async () => {
    expect(await run(['help'])).toBe(0)
    const t = text()
    expect(t).toContain('快速开始')
    expect(t).toContain('【接入 AI / Connect an agent】')
    expect(t).not.toContain('(stub in M1)')
    expect(t).toContain('gitrader keys list ')
    out = []
    expect(await run(['keys', 'new', 'agent', '--help'])).toBe(0)
    const sub = text()
    expect(sub).toContain('gitrader keys new agent <name> --host')
    expect(sub).toContain('--max-order N') // 续行带上
    expect(sub).not.toContain('keys revoke')
    expect(sub).not.toContain('keys list')
  })
})

describe('UX-28 时间按本地时区并标明', () => {
  it('fmtLocal 带时区标记', () => {
    const s = fmtLocal(Date.UTC(2026, 11, 14, 0, 12))
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC([+-]\d+(:\d{2})?)?\)$/)
  })
})

describe('UX-05 会话登录：整条登录链接也认', () => {
  it('bootTokenFrom：链接取 launch= 后面那段，裸令牌原样', () => {
    const boot = `boot_${'A'.repeat(52)}`
    expect(bootTokenFrom(`http://127.0.0.1:47391/?launch=${boot}`)).toBe(boot)
    expect(bootTokenFrom(boot)).toBe(boot)
    expect(bootTokenFrom('nonsense')).toBe('nonsense')
  })

  it('engines bind：没登录会话时先报错，不先问 PIN', async () => {
    await run(['init', '--no-pin'])
    const h = await runServe(home, { io: io(), connectors: false })
    try {
      let asked = 0
      err = []
      expect(await run(['engines', 'bind', 'gitrader-core'], { readSecret: async () => { asked++; return '000000' } })).toBe(1)
      expect(asked).toBe(0)
      expect(err.join('')).toContain('gitrader session login')
    } finally { await h.stop() }
  })
})

describe('UX-01 / UX-12 doctor', () => {
  const saved = { ...doctorDeps }
  beforeEach(() => { Object.assign(doctorDeps, { liveService: async () => null, mcpEntry: () => ({ path: fileURLToPath(import.meta.url), built: true }), staticDir: () => tmpdir(), verifyLedgerOffline: () => ({ ok: true, count: 0 }) }) })
  afterEach(() => { Object.assign(doctorDeps, saved) })

  it('目录在、配置不在、没有任何用过的痕迹 = 「还没初始化」警告，不是配置损坏的阻塞项', async () => {
    mkdirSync(home, { recursive: true })
    const checks = await runChecks(home, doctorDeps)
    const cfg = checks.find((c) => c.id === 'config')!
    expect(cfg.level).toBe('warn')
    expect(cfg.zh).toContain('还没初始化')
    expect(cfg.next).toBe('gitrader init')
    expect(checks.some((c) => c.level === 'block')).toBe(false)
    expect(await run(['doctor'])).toBe(1)
    expect(text()).not.toContain('配置文件读不出来')
  })

  it('配置不在但主目录里有 keys/pin.json 之类的痕迹，仍是阻塞项（原有行为）', async () => {
    initHome(home)
    rmSync(join(home, 'gitrader.json'))
    mkdirSync(join(home, 'keys'), { recursive: true })
    writeFileSync(join(home, 'keys', 'pin.json'), '{}')
    const cfg = (await runChecks(home, doctorDeps)).find((c) => c.id === 'config')!
    expect(cfg.level).toBe('block')
  })

  it('命令行与在跑的服务版本不一致 → 警告并说明重启', async () => {
    initHome(home)
    const svc = { port: 1, pid: process.pid, token: 't', startedAt: 1, version: '0.1.0' }
    const checks = await runChecks(home, { ...doctorDeps, liveService: async () => svc, health: async () => ({ ok: true, version: '0.1.0', status: 'ok' }), callOp: async (_s, op) => (op === 'status' ? { version: '0.1.0', tradingState: 'ACTIVE' } : null) })
    const v = checks.find((c) => c.id === 'version')!
    expect(v.level).toBe('warn')
    expect(v.zh).toContain(`命令行是 ${KERNEL_VERSION}`)
    expect(v.zh).toContain('0.1.0')
    expect(v.next).toContain('gitrader stop')
    const same = await runChecks(home, { ...doctorDeps, liveService: async () => svc, health: async () => ({ ok: true, version: KERNEL_VERSION, status: 'ok' }), callOp: async (_s, op) => (op === 'status' ? { version: KERNEL_VERSION, tradingState: 'ACTIVE' } : null) })
    expect(same.find((c) => c.id === 'version')).toBeUndefined()
  })

  it('--json 的 next 在设了启动器名时也换成启动器名', async () => {
    mkdirSync(home, { recursive: true })
    expect(await run(['doctor', '--json'], { env: { GITRADER_HOME: home, GITRADER_LAUNCHER: 'C:\\p\\gitrader.cmd' } })).toBe(0)
    const rows = JSON.parse(text()).checks as Array<{ id: string; next?: string }>
    expect(rows.find((r) => r.id === 'config')!.next).toBe('C:\\p\\gitrader.cmd init')
  })
})

describe('UX-17 serve --detach 起不来：把关键报错行单独说出来', () => {
  it('日志里最后一条报错放在结尾一句里', async () => {
    const logs: string[] = []
    const code = await cmdServeDetach(home, { cmd: ['serve'], flags: { detach: true } }, io({ env: {}, err: (s) => { logs.push(s) } }), {
      spawn: (_c, _a, o) => { if (Array.isArray(o.stdio)) writeFileSync(o.stdio[1] as number, 'starting\nerror: port 47391 is not available\n'); return { pid: 1, unref: () => undefined } }, // taskkill 的 stdio 是字符串，别当 fd 写
      liveService: async () => null,
      now: (() => { let t = 0; return () => (t += 20_000) })(),
      sleep: async () => undefined,
    })
    expect(code).toBe(1)
    expect(logs.join('')).toContain('服务没能启动：port 47391 is not available')
  })
})

describe('UX-08 / UX-19 / UX-03 mcp snippet', () => {
  it('--token-file 所在目录不存在（路径带引号 / 抄错）→ 报错退出 1；目录在文件还没建 → 提醒但照常输出', async () => {
    expect(await run(['mcp', 'snippet', 'claude-code', '--token-file', "'D:\\no-such-dir\\ui-test.token'"])).toBe(1)
    expect(err.join('')).toContain('令牌文件路径不对')
    expect(text()).toBe('')
    err = []
    expect(await run(['mcp', 'snippet', 'claude-code', '--token-file', join(home, 'later.token')])).toBe(0)
    expect(err.join('')).toContain('令牌文件还不存在')
    expect(text()).toContain('GITRADER_AGENT_TOKEN_FILE')
  })

  it('other 当 generic 用；给了令牌文件时片段头写「已用令牌文件」，页脚不再说「在工作台设钥匙档位」', async () => {
    const file = join(home, 'a.token')
    writeFileSync(file, 'x')
    expect(await run(['mcp', 'snippet', 'other', '--token-file', file])).toBe(0)
    const t = text()
    expect(t).toContain('mcpServers')
    expect(t).toContain('已用令牌文件')
    expect(t).not.toContain('The key level is set in the workbench')
    expect(t).not.toContain('printed once')
  })

  it('没给令牌文件的片段：建钥匙命令统一成 --preset starter --token-file，不再写 --tier paper', () => {
    for (const host of ['claude-code', 'codex', 'hermes'] as const) {
      const t = renderSnippet({ host, node: 'node', mcpEntry: '/m.js', home: '/h' })
      expect(t).toContain('--preset starter --token-file')
      expect(t).not.toContain('--tier paper')
      expect(t).not.toContain('只显示一次')
    }
  })
})

describe('UX-07 open 的 PIN 错误说人话', () => {
  it('错 PIN / 空 PIN：中文界面不露英文原文', async () => {
    await run(['init', '--no-pin'])
    const h = await runServe(home, { io: io(), connectors: false })
    try {
      await h.kernel.auth.setupPinLocalTerminal('482916')
      secrets = ['000000']
      err = []
      expect(await run(['open', '--print'])).toBe(1)
      expect(err.join('')).not.toContain('invalid PIN')
      expect(err.join('')).toMatch(CJK)
      secrets = ['']
      err = []
      expect(await run(['open', '--print'])).toBe(1)
      expect(err.join('')).not.toContain('presence proof')
      expect(err.join('')).toMatch(CJK)
    } finally { await h.stop() }
  })
})

describe('UX-13 open 文案（没设 PIN）', () => {
  it('中文：说明怎么办；英文界面是英文', async () => {
    await run(['init', '--no-pin'])
    const h = await runServe(home, { io: io(), connectors: false })
    try {
      expect(await run(['open', '--print'])).toBe(1)
      expect(err.join('')).toContain('还没有设置 PIN（No PIN is set yet）')
      err = []
      expect(await run(['open', '--print', '--lang', 'en'])).toBe(1)
      expect(err.join('')).toContain('No PIN is set yet')
      expect(err.join('')).not.toMatch(CJK)
    } finally { await h.stop() }
  })
})

void Kernel; void existsSync; void readFileSync
