// SPDX-License-Identifier: Apache-2.0
// 工具型示例 position-size：纯函数（8 位定点、向下取整）+ 清单 + 拿真内核对拍（reload → 启用 → 拉起子进程 → tool.call）。
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Kernel, artifactList, fileProvider, pinOf } from '@gitrader/kernel'
import { checkPluginManifestIssues, validatePluginManifest, type PluginManifest } from '@gitrader/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 示例，没有类型声明
import { positionSize } from '../example/position-size/index.mjs'
// @ts-expect-error 纯 JS 示例，没有类型声明
import { format, mulDiv, parse } from '../example/position-size/decimal.mjs'

const dir = resolve(__dirname, '../example/position-size')
const manifest = JSON.parse(readFileSync(join(dir, 'gitrader-plugin.json'), 'utf8')) as PluginManifest
const ID = 'skill.example.position-size'
const ARGS = { equity: '10000', riskPct: '1', entry: '100', stop: '95' }

describe('position_size 纯函数', () => {
  it('equity × riskPct ÷ 100 ÷ |entry − stop|；多头空头对称', () => {
    expect(positionSize(ARGS)).toEqual({ qty: '20.00000000' })
    expect(positionSize({ ...ARGS, entry: '95', stop: '100' })).toEqual({ qty: '20.00000000' })
    expect(positionSize({ equity: '100', riskPct: '0.5', entry: '7', stop: '9' })).toEqual({ qty: '0.25000000' })
  })
  it('向下取整到 8 位，不四舍五入；不经过浮点数', () => {
    expect(positionSize({ equity: '1', riskPct: '1', entry: '3', stop: '0' })).toEqual({ qty: '0.00333333' }) // 0.01 ÷ 3
    expect(positionSize({ equity: '0.1', riskPct: '0.1', entry: '3', stop: '0' })).toEqual({ qty: '0.00003333' })
    // 123456789.12345678 × 0.25 ÷ 100 ÷ 1000.25：测试里直接用整数（单位 1e-8）独立算一遍
    const qty = (12345678912345678n * 25000000n) / (100n * 100025000000n)
    expect(positionSize({ equity: '123456789.12345678', riskPct: '0.25', entry: '65000.5', stop: '64000.25' }).qty).toBe(format(qty))
  })
  it('entry === stop：抛错（经 GSP 变成 -32602）', () => {
    expect(() => positionSize({ ...ARGS, stop: '100' })).toThrow(/must differ/)
    expect(() => positionSize({ ...ARGS, stop: '100.000' })).toThrow(/must differ/)
  })
  it('decimal：解析 / 格式化 / 非法输入', () => {
    expect(format(parse('12.5'))).toBe('12.50000000')
    expect(format(parse('0.123456789'))).toBe('0.12345678')
    expect(format(mulDiv(parse('2'), parse('3'), parse('4')))).toBe('1.50000000')
    expect(() => parse('-1')).toThrow(/not a decimal/)
    expect(() => parse('1e3')).toThrow(/not a decimal/)
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(/division by zero/)
  })
})

describe('清单', () => {
  it('过协议校验、零权限、无网络；钉的哈希就是目录内容哈希', () => {
    const r = validatePluginManifest(manifest)
    expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true)
    expect(checkPluginManifestIssues(manifest)).toEqual([])
    expect(manifest.permissions).toEqual([])
    expect(manifest.net).toBeUndefined()
    expect(manifest.provides).toEqual({ tools: ['position_size'] })
    expect(manifest.compat.gitrader).toBe('>=0.1.0 <0.2.0')
    expect(manifest.source.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(manifest.source.sha256).not.toBe('sha256:' + '0'.repeat(64))
    expect(manifest.source.sha256).toBe(pinOf(artifactList(dir)))
  })
  it('gsp.mjs 不超过 40 行', () => {
    expect(readFileSync(join(dir, 'gsp.mjs'), 'utf8').trimEnd().split('\n').length).toBeLessThanOrEqual(40)
  })
})

describe('GSP 循环（直接起子进程，不经内核）', () => {
  const run = (lines: object[]): Promise<Array<Record<string, any>>> => // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise((res, rej) => {
      const p = spawn(process.execPath, [join(dir, 'index.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      p.stdout.on('data', (d) => { out += d })
      p.on('error', rej)
      p.on('close', () => res(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))))
      p.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n') // 不关 stdin：进程靠 plugin.shutdown 自己退出
      setTimeout(() => p.kill(), 5000).unref()
    })
  it('hello / health / shutdown 回 ok；未知方法与未知工具回 -32601；entry === stop 回 -32602；shutdown 后进程退出', async () => {
    const out = await run([
      { jsonrpc: '2.0', id: 1, method: 'plugin.hello', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'plugin.health', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'nope', params: {} },
      { jsonrpc: '2.0', id: 4, method: 'tool.call', params: { tool: 'constructor', args: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tool.call', params: { tool: 'position_size', args: { ...ARGS, stop: '100' } } },
      { jsonrpc: '2.0', id: 6, method: 'tool.call', params: { tool: 'position_size', args: ARGS } },
      { jsonrpc: '2.0', id: 7, method: 'plugin.shutdown', params: {} },
    ])
    const by = (id: number) => out.find((m) => m.id === id)!
    expect(by(1).result).toEqual({ ok: true })
    expect(by(2).result).toEqual({ ok: true })
    expect(by(3).error.code).toBe(-32601)
    expect(by(4).error.code).toBe(-32601)
    expect(by(5).error).toMatchObject({ code: -32602 })
    expect(by(5).error.message).not.toMatch(/\n\s+at /)
    expect(by(6).result).toEqual({ qty: '20.00000000' })
    expect(by(7).result).toEqual({ ok: true })
  })
})

describe('内核对拍（真内核、真子进程）', () => {
  let home: string
  let k: Kernel
  const grantOnce = () => {
    const s = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!
    return k.plugins.grant(ID, [], k.auth.sessionProof(s))
  }
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gr-possize-'))
    k = await Kernel.create({ home, deviceKeyProvider: fileProvider, timers: false })
    k.config.plugins.developerMode = true
    cpSync(dir, join(k.paths.plugins, 'position-size'), { recursive: true })
  })
  afterAll(async () => { await k.plugins.stopAll().catch(() => undefined); await k.stop().catch(() => undefined); rmSync(home, { recursive: true, force: true }) })

  it('加载：校验通过、哈希与签名状态正确；没启用前调用被拒（2004）', async () => {
    const r = await k.plugins.reload()
    expect(r.rejected).toEqual([])
    expect(r.added).toEqual([ID])
    expect(k.plugins.get(ID)).toMatchObject({ ok: true, signed: false, version: '0.1.0', pin: manifest.source.sha256 })
    await k.plugins.start(ID)
    await expect(k.plugins.callTool(ID, 'position_size', ARGS)).rejects.toMatchObject({ problem: { code: 2004 } })
  })

  it('grant(id, []) 即启用；零权限工具可调 → { qty: "20.00000000" }', async () => {
    grantOnce()
    expect(await k.plugins.callTool(ID, 'position_size', ARGS)).toEqual({ qty: '20.00000000' })
  })

  it('缺 stop → -32602 且提到字段；入参多余字段也拒；entry === stop → 插件回的错误', async () => {
    await expect(k.plugins.callTool(ID, 'position_size', { equity: '10000', riskPct: '1', entry: '100' })).rejects.toMatchObject({ problem: { code: -32602, message: expect.stringContaining('stop') } })
    await expect(k.plugins.callTool(ID, 'position_size', { ...ARGS, extra: '1' })).rejects.toMatchObject({ problem: { code: -32602 } })
    await expect(k.plugins.callTool(ID, 'position_size', { ...ARGS, stop: '100' })).rejects.toBeDefined()
  })

  it('清单没声明的工具 → 5008', async () => {
    await expect(k.plugins.callTool(ID, 'not_declared', {})).rejects.toMatchObject({ problem: { code: 5008 } })
  })

  it('改了目录里的任何文件 → 哈希对不上，拒装；改回后恢复', async () => {
    const f = join(k.paths.plugins, 'position-size', 'index.mjs')
    const orig = readFileSync(f, 'utf8')
    writeFileSync(f, orig + '\n// tampered\n')
    const r = await k.plugins.reload()
    expect(r.rejected[0]!.issues.join(' ')).toMatch(/hash mismatch/)
    writeFileSync(f, orig)
    expect((await k.plugins.reload()).rejected).toEqual([])
  })
})
