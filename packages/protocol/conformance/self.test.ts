// SPDX-License-Identifier: Apache-2.0
// 套件的自检：
//  1. 假引擎故障注入——套件必须抓得到坏引擎（每个故障对应一条应当失败的用例）；
//  2. stdio 传输：把假引擎打包成独立 Node 进程，经 NDJSON 跑一遍核心用例（模拟"任意语言子进程"）；
//  3. 用例编号齐全。
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe as baseDescribe, expect, it } from 'vitest'
import { validateEngineLaunch } from '../src'
import { MODE_A_CASES } from './cases/mode-a'
import { OPTIONAL_CASES } from './cases/optional'
import { REQUIRED_CASES } from './cases/required'
import type { Case } from './cases/common'
import type { FakeFaults } from './fake-engine'
import { HostSim } from './host-sim'
import { runCase } from './run'
import { GepSession } from './session'
import { loadTarget, type Target } from './target'
import { stdioTransport } from './transport'

const here = dirname(fileURLToPath(import.meta.url))
/** 设了 GEP_LAUNCH / GEP_ENDPOINT 时套件在对真引擎运行：自检（假引擎 + 故障注入）不适用，整个文件跳过。 */
const external = Boolean(process.env['GEP_LAUNCH'] || process.env['GEP_ENDPOINT'])
const describe = external ? baseDescribe.skip : baseDescribe
const ALL: Case[] = [...REQUIRED_CASES, ...MODE_A_CASES, ...OPTIONAL_CASES]
const byId = (id: string): Case => ALL.find((c) => c.id === id)!

describe('套件能抓到坏引擎（故障注入）', () => {
  const faults: [keyof FakeFaults, string[]][] = [
    ['leakSecret', ['T15']],
    ['noSecretCheck', ['T14']],
    ['acceptBadToken', ['T03']],
    ['ignoreHalt', ['T16', 'T17', 'T18']],
    ['missingInstanceId', ['T26']],
    ['decimalAsNumber', ['T21']],
    ['resplitAfterDeny', ['A1']],
    ['blindRetry3006', ['T24']],
    ['unknownCapability', ['T04']],
    ['noCapabilityHonesty', ['T05']],
    ['noDedupe', ['T09']],
    ['nondeterministicBacktest', ['O3']],
    ['ignoreHeartbeatLoss', ['T07']],
    ['noEngineHeartbeat', ['T27']],
  ]
  for (const [fault, ids] of faults) {
    for (const id of ids) {
      it(`${fault} → ${id} 失败`, async () => {
        const t = await loadTarget({ fake: { faults: { [fault]: true } } })
        const r = await runCase(byId(id), t)
        expect(r.status, `${id} should fail when the engine has fault ${fault}${r.note ? ` (${r.note})` : ''}`).toBe('fail')
      }, 60_000)
    }
  }
  it('健康的假引擎：全部必测用例通过（没有跳过）', async () => {
    const t = await loadTarget()
    for (const c of REQUIRED_CASES) {
      const r = await runCase(c, t)
      expect(r.status, `${c.id}: ${r.note ?? ''}`).toBe('pass')
    }
  }, 120_000)
})

describe('stdio 传输：独立 Node 进程的引擎（模拟任意语言子进程）', () => {
  let dir = ''
  let script = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gep-fake-'))
    script = join(dir, 'fake-engine.mjs')
    await build({ entryPoints: [join(here, 'fake-engine-main.ts')], bundle: true, platform: 'node', format: 'esm', outfile: script, logLevel: 'silent' })
  })
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  const launch = () => ({ command: process.execPath, args: [script], env: { FAKE_GEP_HB_TIMEOUT_MS: '600' } })
  const target = (): Target => {
    const host = new HostSim()
    const token = 'stdio-token'
    return {
      kind: 'stdio', label: 'stdio fake', token, host,
      timing: { heartbeatLossWaitMs: 1200, backpressureWaitMs: 300, reconnectAfterMs: 300, splitWatchMs: 800, settleMs: 120, eventVolume: 2000 },
      open: async () => { host.clear(); return new GepSession(stdioTransport(launch(), token), host) },
      reopen: async () => null,
      cleanup: async () => {},
    }
  }

  it('启动配置是语言无关的 { command, args, env }', () => {
    expect(validateEngineLaunch(launch()).ok).toBe(true)
  })
  for (const id of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T13', 'T14', 'T16', 'T21', 'T24', 'T25', 'T27', 'O1', 'O3']) {
    it(`${id} 经 stdio 通过`, async () => {
      const r = await runCase(byId(id), target())
      expect(r.status, `${id}: ${r.note ?? ''}`).toBe('pass')
    }, 60_000)
  }
  it('stdio 引擎不能续传：T10 跳过而不是失败', async () => {
    const r = await runCase(byId('T10'), target())
    expect(r.status).toBe('skip')
  }, 60_000)
})

describe('用例清单', () => {
  it('编号齐全：T01–T27、A1–A3、O1–O8，且不重复', () => {
    const ids = ALL.map((c) => c.id)
    for (let i = 1; i <= 27; i++) expect(ids).toContain(`T${String(i).padStart(2, '0')}`)
    for (const id of ['A1', 'A2', 'A3', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8']) expect(ids).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('README 说明了两种接入方式', () => {
    const text = readFileSync(join(here, 'README.md'), 'utf8')
    expect(text).toContain('GEP_ENDPOINT')
    expect(text).toContain('GEP_LAUNCH')
  })
})
