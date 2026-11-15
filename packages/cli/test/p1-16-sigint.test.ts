// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeStopper } from '../src/index'
import type { StopperStdin } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const jitiCli = join(repoRoot, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs')
const binTs = join(repoRoot, 'packages', 'cli', 'src', 'bin.ts')

let home: string

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-sigint-')) })
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

/** 记下注册过的 data 监听与 pause / unref 调用，替代 process.stdin。 */
function fakeStdin(): StopperStdin & { handlers: (() => void)[]; paused: number; unrefed: number } {
  const handlers: (() => void)[] = []
  let paused = 0
  let unrefed = 0
  return {
    handlers,
    get paused() { return paused },
    get unrefed() { return unrefed },
    on: (event, listener) => { if (event === 'data') handlers.push(listener); return undefined },
    off: (event, listener) => { if (event === 'data') { const i = handlers.indexOf(listener); if (i >= 0) handlers.splice(i, 1) } return undefined },
    pause: () => { paused++; return undefined },
    unref: () => { unrefed++; return undefined },
  }
}

describe('serve stops on ctrl+c', () => {
  // Windows 上 child.kill('SIGINT') 只是强杀，不会走到 SIGINT 处理器，退出码也不是 0 / 130。
  it.skipIf(process.platform === 'win32')('first ctrl+c stops serve and the process exits', async () => {
    const child = spawn(process.execPath, [jitiCli, binTs, 'serve', '--offline', '--port', '0'], {
      env: { ...process.env, GITRADER_HOME: home, GITRADER_OFFLINE: '1', GITRADER_LANG: 'en' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<{ code: number | null }>((done) => { child.once('exit', (code) => done({ code })) })
    try {
      let started = ''
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => { fail(new Error(`serve did not start in time: ${started}`)) }, 10_000)
        child.stdout.on('data', (c: Buffer) => {
          started += c.toString('utf8')
          if (started.includes('is running on')) { clearTimeout(timer); done() }
        })
        child.once('exit', () => { clearTimeout(timer); fail(new Error(`serve exited before it was up: ${started}`)) })
      })
      child.kill('SIGINT')
      const code = await Promise.race([
        exited.then((r) => r.code),
        new Promise<never>((_, fail) => setTimeout(() => { fail(new Error('serve did not exit within 5 s of SIGINT')) }, 5_000)),
      ])
      expect([0, 130]).toContain(code)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })

  it('second signal exits immediately', async () => {
    const exits: number[] = []
    let stops = 0
    let release: () => void = () => undefined
    const stopping = new Promise<void>((done) => { release = done })
    const stopper = makeStopper({ stop: () => { stops++; return stopping }, stdin: fakeStdin(), exit: (code) => { exits.push(code) } })
    const first = stopper.stop()
    void stopper.stop()
    expect(exits).toEqual([130])
    expect(stops).toBe(1)
    release()
    await first
    expect(exits).toEqual([130])
  })

  it('stdin listener is removed on stop', async () => {
    const stdin = fakeStdin()
    const stopper = makeStopper({ stop: () => Promise.resolve(), stdin, exit: () => { throw new Error('stop should not exit on the first signal') } })
    const onData = (): void => undefined
    stopper.listen(onData)
    expect(stdin.handlers).toEqual([onData])
    expect(stopper.listening()).toBe(true)
    await stopper.stop()
    expect(stdin.handlers).toEqual([])
    expect(stdin.paused).toBe(1)
    expect(stdin.unrefed).toBe(1)
    expect(stopper.listening()).toBe(false)
  })
})
