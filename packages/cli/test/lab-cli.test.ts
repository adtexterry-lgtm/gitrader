// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, fileProvider, mkOrigin } from '@gitrader/kernel'
import type { Experiment } from '@gitrader/protocol'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let out: string[]
let err: string[]
const io = (): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  deviceKey: fileProvider,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})
const run = (argv: string[]): Promise<number> => main(argv, io())
const stdout = (): string => out.join('')
const resetOutput = (): void => { out = []; err = [] }

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-lab-cli-')); out = []; err = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader lab', () => {
  it('exports a local experiment bundle and verifies identical and changed files', async () => {
    expect(await run(['init', '--no-pin'])).toBe(0)
    resetOutput()
    const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    let experimentId = ''
    try {
      const exp = await k.lab.handle('create', { patch: { title: 'Sample experiment', hypothesis: 'Observe a sample' } }, {
        principal: { kind: 'service' }, origin: mkOrigin('user:usr_local', 'test:lab', 'cli'),
      }) as Experiment
      experimentId = exp.experimentId
    } finally { await k.stop() }

    expect(await run(['lab', 'export', experimentId])).toBe(0)
    const bundle = JSON.parse(stdout()) as { schema: string; experiment: Experiment }
    expect(bundle.schema).toBe('gitrader-lab-export/1')
    const exportedText = stdout()
    const originalFile = join(home, 'lab', 'original.json')
    writeFileSync(originalFile, exportedText, 'utf8')

    resetOutput()
    expect(await run(['lab', 'verify', 'original.json'])).toBe(0)
    expect(JSON.parse(stdout())).toEqual({ status: 'identical', differences: [] })
    expect(readFileSync(originalFile, 'utf8')).toBe(exportedText)

    bundle.experiment.hypothesis = 'Changed sample observation'
    const changedFile = join(home, 'lab', 'changed.json')
    writeFileSync(changedFile, JSON.stringify(bundle), 'utf8')
    resetOutput()
    expect(await run(['lab', 'verify', 'changed.json'])).toBe(1)
    const diff = JSON.parse(stdout()) as { status: string; differences: string[] }
    expect(diff.status).toBe('diff')
    expect(diff.differences.length).toBeGreaterThan(0)
    expect(readFileSync(originalFile, 'utf8')).toBe(exportedText)
  })

  it('rejects malformed commands and files without echoing paths or file contents', async () => {
    expect(await run(['init', '--no-pin'])).toBe(0)
    resetOutput()
    const malformedFile = join(home, 'lab', 'malformed.json')
    const missingFile = join(home, 'lab', 'missing.json')
    const marker = 'LAB_FILE_CONTENT_SENTINEL'
    writeFileSync(malformedFile, marker, 'utf8')
    const cases = [
      ['lab', 'export'],
      ['lab', 'verify'],
      ['lab', 'unknown', 'arg'],
      ['lab', 'export', 'exp_sample', 'extra'],
      ['lab', 'verify', 'missing.json'],
      ['lab', 'verify', 'malformed.json'],
      ['lab', 'verify', '../gitrader.json'],
      ['lab', 'verify', malformedFile],
    ]
    for (const args of cases) {
      resetOutput()
      expect(await run(args)).toBe(1)
      expect(stdout()).toBe('')
      expect(err.join('').length).toBeGreaterThan(0)
      expect(err.join('')).not.toContain(missingFile)
      expect(err.join('')).not.toContain(malformedFile)
      expect(err.join('')).not.toContain(marker)
    }
  })

  it('GQ-09d lab pack and lab attach require a running service', async () => {
    expect(await run(['init', '--no-pin'])).toBe(0)
    resetOutput()
    
    // lab pack without service
    expect(await run(['lab', 'pack', 'exp_sample', '--run', 'run_sample'])).toBe(1)
    expect(err.join('')).toContain('gitrader serve')
    
    resetOutput()
    // lab attach without service
    expect(await run(['lab', 'attach', 'exp_sample', '--engine', 'eng', '--instance', 'inst', '--account', 'paper'])).toBe(1)
    expect(err.join('')).toContain('gitrader serve')
  })
})
