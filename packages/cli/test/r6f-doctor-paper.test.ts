// SPDX-License-Identifier: CPAL-1.0
// R2-REL-11：doctor 的纸面一致性勾选要如实反映——账本库不在、或纸面状态是首次信任时，不许再写“和账本记录的摘要一致”。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome } from '@gitrader/kernel'
import { doctorDeps, runChecks } from '../src/doctor'
import type { DoctorCheck, DoctorDeps } from '../src/doctor'
import type { ServiceInfo } from '../src/index'

const fakeService: ServiceInfo = { port: 43123, pid: process.pid, token: 'test-token', startedAt: 1, version: 'test' }
const okLedger = { ok: true, mode: 'full', checkedFrom: 0, checkedTo: 3, count: 4, at: 1, durationMs: 1, projection: { checked: 1, ok: true } }
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gr-r6f-doctor-'))
  initHome(home)
  mkdirSync(join(home, 'keys'), { recursive: true })
  writeFileSync(join(home, 'keys', 'pin.json'), '{}\n')
  writeFileSync(join(home, 'mcp.js'), '// stub\n')
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function deps(o: { running: boolean; paperState?: Record<string, unknown> }): Partial<DoctorDeps> {
  return {
    liveService: async () => (o.running ? fakeService : null),
    callOp: async (_svc, op) => {
      if (op === 'status') return { tradingState: 'ACTIVE', stateReasons: [] }
      if (op === 'account.list') return [{ mode: 'paper' }]
      if (op === 'paper.audit') return { paperState: { state: 'ok', dirty: false }, accounts: [] }
      return null
    },
    health: async () => ({ status: 'ok', stateFiles: [], paperState: o.paperState ?? { state: 'ok', dirty: false }, ledgerVerify: okLedger }),
    staticDir: () => home,
    mcpEntry: () => ({ path: join(home, 'mcp.js'), built: true }),
    verifyLedgerOffline: () => ({ ok: false, error: 'ledger database is missing', missing: true }),
    probeWrite: () => undefined,
  }
}
const paperCheck = (checks: DoctorCheck[]): DoctorCheck => checks.find((c) => c.id === 'paper')!

describe('R2-REL-11 doctor 纸面一致性勾选', () => {
  it('[R6F-PS3] doctor does not report the paper check as ok while the ledger is missing or paper state is unverifiedFirstUse', async () => {
    // 服务没跑、账本库不在、paper-state.json 在 → 不是 ok
    writeFileSync(join(home, 'paper-state.json'), JSON.stringify({ v: 1, orderSeq: 1, fillSeq: 1, accounts: [] }))
    const offline = paperCheck(await runChecks(home, { ...doctorDeps, ...deps({ running: false }) }))
    expect(offline.level).not.toBe('ok')
    expect(offline.zh).not.toContain('和账本记录的摘要一致')
    expect(offline.next).toContain('--reset-paper-state')
    // 服务在跑、内核说这份纸面状态是首次信任 → warn
    const online = paperCheck(await runChecks(home, { ...doctorDeps, ...deps({ running: true, paperState: { state: 'ok', dirty: false, unverifiedFirstUse: true } }) }))
    expect(online.level).toBe('warn')
    expect(online.zh).toContain('账本里没有它的摘要')
    // 对照：摘要核对得上（服务在跑、没有 unverifiedFirstUse）仍然是 ok
    const healthy = paperCheck(await runChecks(home, { ...doctorDeps, ...deps({ running: true }) }))
    expect(healthy.level).toBe('ok')
  })
})
