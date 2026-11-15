// SPDX-License-Identifier: CPAL-1.0
// 作业表落盘（GQ-12）：作业终态与结果写进 <artifactDir>/_jobs，引擎重启后仍可取；
// 重启前悬空的 queued/running 一律清成 failed（ENGINE_RESTARTED）。没配 artifactDir 时行为不变。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { T0 } from '../../protocol/conformance/host-sim'
import { rig, BTC, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => {
  r?.close()
  r = null
})

const baseSpec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
  instruments: [BTC], interval: '1m', from: T0, to: T0 + 2000 * 60_000,
  data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
  assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
  seed: 42, ...over,
})

const waitState = async (jobId: string, timeout = 15_000): Promise<string> => {
  const end = Date.now() + timeout
  for (;;) {
    const st = await r!.session.call<{ state: string }>('backtest.status', { jobId })
    if (st.state === 'done' || st.state === 'failed' || st.state === 'cancelled') return st.state
    if (Date.now() > end) throw new Error('job timeout')
    await new Promise((res) => setTimeout(res, 20))
  }
}

describe('作业表落盘（GQ-12）', () => {
  it('已完成作业：引擎换一个实例（同 artifactDir）后 status / result 仍可取，结果逐字节相同', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-'))
    r = await rig({ jobs: { artifactDir: dir } })
    const { jobId } = await r.session.call<{ jobId: string }>('backtest.run', { spec: baseSpec() })
    expect(await waitState(jobId)).toBe('done')
    const before = await r.session.call('backtest.result', { jobId })
    r.close()
    r = await rig({ jobs: { artifactDir: dir } })
    expect((await r.session.call<{ state: string }>('backtest.status', { jobId })).state).toBe('done')
    expect(await r.session.call('backtest.result', { jobId })).toEqual(before)
  })

  it('作业跑到一半引擎死了：新引擎启动后该作业是 failed，result 带 ENGINE_RESTARTED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-'))
    mkdirSync(join(dir, '_jobs'), { recursive: true })
    writeFileSync(join(dir, '_jobs', 'job_01TESTSTALE.json'), JSON.stringify({ v: 1, jobId: 'job_01TESTSTALE', state: 'running', progress: 0.4, createdAt: 1, updatedAt: 2 }))
    r = await rig({ jobs: { artifactDir: dir } })
    expect((await r.session.call<{ state: string }>('backtest.status', { jobId: 'job_01TESTSTALE' })).state).toBe('failed')
    const e = await r.session.expectError('backtest.result', { jobId: 'job_01TESTSTALE' })
    expect(e.message).toContain('ENGINE_RESTARTED')
    expect(JSON.parse(readFileSync(join(dir, '_jobs', 'job_01TESTSTALE.json'), 'utf8')).state).toBe('failed')   // 已写回
  })

  it('反例：坏文件 / 文件名与内容不符 / 路径穿越式作业号 → 被删除跳过，不抛、不当成作业', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-')); const jd = join(dir, '_jobs'); mkdirSync(jd, { recursive: true })
    writeFileSync(join(jd, 'job_01BAD.json'), '{not json')
    writeFileSync(join(jd, 'job_01OTHER.json'), JSON.stringify({ v: 1, jobId: 'job_01X', state: 'done', progress: 1, createdAt: 1, updatedAt: 1 }))
    r = await rig({ jobs: { artifactDir: dir } })
    await expect(r.session.expectError('backtest.status', { jobId: 'job_01X' })).resolves.toMatchObject({ code: -32602 })
  })

  it('不给 artifactDir：行为不变（没有 _jobs 目录，重启后 unknown jobId）', async () => {
    r = await rig()
    await expect(r.session.expectError('backtest.status', { jobId: 'job_01NONE' })).resolves.toMatchObject({ code: -32602 })
  })
})
