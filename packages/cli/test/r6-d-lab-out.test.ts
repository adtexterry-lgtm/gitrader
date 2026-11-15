// SPDX-License-Identifier: CPAL-1.0
// R3-13：lab export --out 写到任意文件并打印路径；lab verify 认任意位置的绝对路径（只读核验），篡改件退出码 1，报错不回显路径和内容。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, fileProvider, mkOrigin } from '@gitrader/kernel'
import type { Experiment } from '@gitrader/protocol'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let elsewhere: string
let out: string[]
let err: string[]
const io = (): CliIo => ({ out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, deviceKey: fileProvider, readSecret: async () => { throw new Error('unexpected secret prompt') } })
const run = (argv: string[]): Promise<number> => main(argv, io())
const reset = (): void => { out = []; err = [] }

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-lab-out-')); elsewhere = mkdtempSync(join(tmpdir(), 'gitrader-lab-elsewhere-')); out = []; err = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }); rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }) })

async function makeExperiment(): Promise<string> {
  expect(await run(['init', '--no-pin'])).toBe(0)
  reset()
  const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
  try {
    const exp = await k.lab.handle('create', { patch: { title: 'Sample experiment', hypothesis: 'Observe a sample' } }, { principal: { kind: 'service' }, origin: mkOrigin('user:usr_local', 'test:lab', 'cli') }) as Experiment
    return exp.experimentId
  } finally { await k.stop() }
}

describe('lab export --out / verify <绝对路径>', () => {
  it('--out 把包写到 home 之外的文件并打印路径；不带 --out 仍打到 stdout', async () => {
    const id = await makeExperiment()
    const file = join(elsewhere, 'pack.json')
    expect(await run(['lab', 'export', id, '--out', file])).toBe(0)
    expect(out.join('')).toContain(file)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { schema: string }).schema).toBe('gitrader-lab-export/1')
    reset()
    expect(await run(['lab', 'export', id])).toBe(0)
    expect((JSON.parse(out.join('')) as { schema: string }).schema).toBe('gitrader-lab-export/1')
  })

  it('verify 认 home 之外的绝对路径：原件 identical 退出 0，篡改件退出 1', async () => {
    const id = await makeExperiment()
    const file = join(elsewhere, 'pack.json')
    expect(await run(['lab', 'export', id, '--out', file])).toBe(0)
    reset()
    expect(await run(['lab', 'verify', file])).toBe(0)
    expect(out.join('')).toContain('identical')
    const bundle = JSON.parse(readFileSync(file, 'utf8')) as { experiment: Experiment }
    bundle.experiment.hypothesis = 'tampered'
    const tampered = join(elsewhere, 'tampered.json')
    writeFileSync(tampered, JSON.stringify(bundle), 'utf8')
    reset()
    expect(await run(['lab', 'verify', tampered])).toBe(1)
    expect(out.join('')).toContain('diff')
    expect(existsSync(join(home, 'lab', 'pack.json'))).toBe(false) // 只读核验：不往 home 里拷任何东西
  })

  it('绝对路径文件缺失 / 不是 JSON：退出 1，stdout 为空，报错不回显路径和文件内容', async () => {
    await makeExperiment()
    const marker = 'LAB_OUT_SENTINEL'
    const bad = join(elsewhere, 'bad.json')
    writeFileSync(bad, marker, 'utf8')
    for (const file of [bad, join(elsewhere, 'missing.json')]) {
      reset()
      expect(await run(['lab', 'verify', file])).toBe(1)
      expect(out.join('')).toBe('')
      expect(err.join('')).not.toContain(file)
      expect(err.join('')).not.toContain(marker)
    }
  })

  it('--out 不带值 / 给 verify 用 --out：用法错误，退出 1', async () => {
    await makeExperiment()
    reset()
    expect(await run(['lab', 'export', 'exp_x', '--out'])).toBe(1)
    expect(await run(['lab', 'verify', 'x.json', '--out', 'y'])).toBe(1)
  })
})
