// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdServeDetach } from '../src/serve-detach'
import type { ServeDetachDeps } from '../src/serve-detach'
import type { Args, CliIo } from '../src/index'

const PID = 4321
const PORT = 4567
const LINK = `http://127.0.0.1:${PORT}/?launch=one-time-token`

let home: string
let stdout: string[]
let stderr: string[]

function makeIo(): CliIo {
  return {
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    env: { KEEP: 'kept' },
    interactive: false,
    readSecret: async () => { throw new Error('unexpected prompt') },
  }
}

function makeArgs(flags: Record<string, string | true> = {}): Args {
  return { cmd: ['serve'], flags: { detach: true, ...flags } }
}

function baseDeps(overrides: Partial<ServeDetachDeps>): ServeDetachDeps {
  return {
    spawn: () => ({ pid: PID, unref: () => undefined }),
    liveService: async () => null,
    now: () => Date.now(),
    sleep: async () => undefined,
    ...overrides,
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-detach-'))
  stdout = []
  stderr = []
})

afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe('serve --detach', () => {
  it('already running prints existing port and does not spawn', async () => {
    const spawn = vi.fn(() => ({ pid: PID, unref: () => undefined }))
    const code = await cmdServeDetach(home, makeArgs(), makeIo(), baseDeps({
      spawn,
      liveService: async () => ({ port: PORT, pid: PID }),
    }))

    expect(code).toBe(0)
    expect(stdout.join('')).toContain(`服务已经在运行（端口 ${PORT}）。要新的登录链接：gitrader open`)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('prints the launch link once the log shows it', async () => {
    const at = new Date(2025, 0, 2, 3, 4, 5).getTime()
    const spawn = vi.fn((command: string, _args: string[], options: Parameters<ServeDetachDeps['spawn']>[2]) => {
      if (command === process.execPath) writeSync(options.stdio?.[1] as number, `${LINK}\n`)
      return { pid: PID, unref: () => undefined }
    })
    const liveService = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ port: PORT, pid: PID })
    const code = await cmdServeDetach(home, makeArgs(), makeIo(), baseDeps({
      spawn,
      liveService,
      now: () => at,
    }))

    const log = join(home, 'logs', 'serve-20250102-030405.log')
    expect(code).toBe(0)
    expect(stdout.join('')).toContain(`服务已在后台启动（端口 ${PORT}，进程 ${PID}）。`)
    expect(stdout.join('')).toContain(`请在 2 分钟内打开下面的链接（只能用一次）：${LINK}`)
    // fix-r4: 新增 gitrader stop 命令，停止提示由「结束进程 PID」改为「gitrader stop」
    expect(stdout.join('')).toContain(`日志：${log}　停止：gitrader stop`)
    // fix-r4: 同上，原先断言输出里没有 gitrader stop
    expect(stdout.join('')).toContain('gitrader stop')
  })

  it('timeout prints log tail and kills only its own pid', async () => {
    let clock = new Date(2025, 0, 2, 3, 4, 5).getTime()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const spawn = vi.fn((command: string, _args: string[], options: Parameters<ServeDetachDeps['spawn']>[2]) => {
      if (command === process.execPath) {
        const lines = Array.from({ length: 25 }, (_, i) => `tail-${i + 1}`).join('\n')
        writeSync(options.stdio?.[1] as number, `${lines}\n`)
      }
      return { pid: PID, unref: () => undefined }
    })
    try {
      const code = await cmdServeDetach(home, makeArgs(), makeIo(), baseDeps({
        spawn,
        now: () => clock,
        sleep: async (ms) => { clock += ms },
      }))

      expect(code).toBe(1)
      expect(stderr.join('')).toContain(Array.from({ length: 20 }, (_, i) => `tail-${i + 6}`).join('\n'))
      expect(stderr.join('')).not.toContain('tail-5')
      expect(stderr.join('')).toContain('服务没能启动，看上面的日志')
      if (process.platform === 'win32') {
        expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', String(PID), '/T', '/F'], expect.anything())
      } else {
        expect(killSpy).toHaveBeenCalledWith(PID)
      }
    } finally {
      killSpy.mockRestore()
    }
  })

  it('child args drop --detach and keep --port', async () => {
    const at = new Date(2025, 0, 2, 3, 4, 5).getTime()
    const spawn = vi.fn((command: string, _args: string[], options: Parameters<ServeDetachDeps['spawn']>[2]) => {
      if (command === process.execPath) writeSync(options.stdio?.[1] as number, `${LINK}\n`)
      return { pid: PID, unref: () => undefined }
    })
    const code = await cmdServeDetach(home, makeArgs({ port: '8787' }), makeIo(), baseDeps({
      spawn,
      liveService: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ port: PORT, pid: PID }),
      now: () => at,
    }))

    expect(code).toBe(0)
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual([process.argv[1]!, 'serve', '--port', '8787'])
    expect(args).not.toContain('--detach')
    expect(options).toMatchObject({
      detached: true,
      windowsHide: true,
      env: expect.objectContaining({ KEEP: 'kept', GITRADER_HOME: home }),
    })
  })
})
