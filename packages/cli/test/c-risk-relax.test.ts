// SPDX-License-Identifier: CPAL-1.0
// 契约 C1：risk relax 默认临时放宽（≤24 小时），--permanent 才永久改上限。真内核（进程内 runServe），不 mock 接缝。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'

const PIN = '246810'
let home: string
let service: ServeHandle | undefined
let out: string[]
let errors: string[]
let secrets: string[]

const io = (): CliIo => ({
  out: (value) => out.push(value),
  err: (value) => errors.push(value),
  env: { GITRADER_HOME: home },
  interactive: true,
  deviceKey: fileProvider,
  readSecret: async () => {
    const value = secrets.shift()
    if (value === undefined) throw new Error('missing test secret input')
    return value
  },
})
const run = (args: string[]): Promise<number> => main(args, io())
const patch = JSON.stringify({ limits: { maxPositionNotionalRatio: '1.02' } })
const temporary = (): { until: number; fields: Record<string, string> } | null | undefined => service!.kernel.risk.current()?.temporaryRelax as never

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-c-relax-'))
  out = []; errors = []; secrets = [PIN, PIN]
  expect(await run(['init'])).toBe(0)
  service = await runServe(home, { port: 0, io: io(), connectors: false })
  secrets = [service.kernel.auth.mintBootToken()]
  expect(await run(['session', 'login'])).toBe(0)
  out = []; errors = []
})

afterEach(async () => {
  await service?.stop()
  service = undefined
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

describe('gitrader risk relax（C1）', () => {
  it('defaults to a 4 hour temporary relax', async () => {
    secrets = [PIN]
    const before = Date.now()
    expect(await run(['risk', 'relax', patch]), errors.join('')).toBe(0)
    expect(out.join('')).toContain('临时放宽至')
    expect(out.join('')).toContain('到期自动收回')
    const t = temporary()
    expect(t?.fields).toEqual({ maxPositionNotionalRatio: '1.02' })
    expect(t!.until - before).toBeGreaterThan(4 * 3_600_000 - 5_000)
    expect(t!.until - before).toBeLessThan(4 * 3_600_000 + 60_000)
  })

  it('--hours sets the duration and more than 24 is refused without touching policy', async () => {
    secrets = [PIN]
    const before = Date.now()
    expect(await run(['risk', 'relax', patch, '--hours', '1']), errors.join('')).toBe(0)
    expect(temporary()!.until - before).toBeLessThan(3_600_000 + 60_000)

    out = []; errors = []
    expect(await run(['risk', 'relax', patch, '--hours', '25'])).toBe(1)
    expect(errors.join('')).toContain('最长 24 小时')
    expect(out.join('')).not.toContain('临时放宽至')
  })

  it('--permanent changes the signed limits and leaves no temporary relax', async () => {
    secrets = [PIN]
    expect(await run(['risk', 'relax', patch, '--permanent']), errors.join('')).toBe(0)
    expect(out.join('')).toContain('已永久修改上限（不会自动收回）')
    expect(temporary() ?? null).toBeNull()
    expect(service!.kernel.risk.current()?.limits.maxPositionNotionalRatio).toBe('1.02')
  })

  it('temporary relax only accepts limits', async () => {
    expect(await run(['risk', 'relax', JSON.stringify({ limits: {}, maxDriftBps: 5 })])).toBe(1)
    expect(errors.join('')).toContain('--permanent')
  })
})
