// SPDX-License-Identifier: CPAL-1.0
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { liveService as realLiveService } from './index'
import type { Args, CliIo } from './index'
import { tr } from './lang'

const POLL_INTERVAL_MS = 200
const TIMEOUT_MS = 30_000
const LOG_TAIL_LINES = 20
const LAUNCH_LINK = /https?:\/\/127\.0\.0\.1:\d+\/\?launch=\S+/

export interface DetachedChild {
  pid?: number
  unref?(): void
}

export interface ServeDetachDeps {
  spawn(command: string, args: string[], options: SpawnOptions): DetachedChild
  liveService(home: string): Promise<{ port: number; pid: number } | null>
  now(): number
  sleep(ms: number): Promise<void>
}

const defaultDeps: ServeDetachDeps = {
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  liveService: realLiveService,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function childArgs(a: Args): string[] {
  const args = ['serve']
  for (const [key, value] of Object.entries(a.flags)) {
    if (key === 'detach') continue
    if (value === true) args.push(`--${key}`)
    else args.push(`--${key}`, value)
  }
  return args
}

function logPath(home: string, at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return join(home, 'logs', `serve-${stamp}.log`)
}

function readLog(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function logTail(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-LOG_TAIL_LINES)
}

function killOwn(pid: number | undefined, spawn: ServeDetachDeps['spawn']): void {
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.unref?.()
    } else process.kill(pid)
  } catch { /* 进程已经退出 */ }
}

export async function cmdServeDetach(home: string, a: Args, io: CliIo, deps: Partial<ServeDetachDeps> = {}): Promise<number> {
  const { spawn, liveService, now, sleep } = { ...defaultDeps, ...deps }
  const existing = await liveService(home)
  if (existing) {
    io.out(tr(io, `服务已经在运行（端口 ${existing.port}）。要新的登录链接：gitrader open\n`, `The service is already running (port ${existing.port}). For a fresh login link run: gitrader open\n`))
    return 0
  }

  const startedAt = now()
  const path = logPath(home, startedAt)
  mkdirSync(dirname(path), { recursive: true })
  let fd: number | undefined
  try {
    fd = openSync(path, 'a')
    const child = spawn(process.execPath, [process.argv[1] ?? '', ...childArgs(a)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...io.env, GITRADER_HOME: home },
    })
    child.unref?.()

    const deadline = startedAt + TIMEOUT_MS
    const maxAttempts = TIMEOUT_MS / POLL_INTERVAL_MS
    for (let attempt = 0; attempt < maxAttempts && now() < deadline; attempt++) {
      const link = LAUNCH_LINK.exec(readLog(path))?.[0]
      const live = await liveService(home)
      if (link && live) {
        io.out(tr(io, `服务已在后台启动（端口 ${live.port}，进程 ${child.pid ?? live.pid}）。\n`, `The service started in the background (port ${live.port}, pid ${child.pid ?? live.pid}).\n`))
        io.out(tr(io, `请在 2 分钟内打开下面的链接（只能用一次）：${link}\n`, `Open this link within 2 minutes (it works once): ${link}\n`))
        io.out(tr(io, `日志：${path}　停止：gitrader stop\n`, `Log: ${path}   Stop: gitrader stop\n`))
        io.out(tr(io, '提示：设好 PIN 之后不需要重启服务；重启会让浏览器里已登录的会话失效。链接用过或过期后，在终端运行 gitrader open 取新的。命令行要登录会话：gitrader session login，把上面的整条链接粘进去即可。\n', 'Tip: you do not need to restart the service after setting a PIN; a restart signs the browser out. When the link is used up or expired, run `gitrader open` for a new one. To sign the command line in: run `gitrader session login` and paste the whole link above.\n'))
        return 0
      }
      await sleep(POLL_INTERVAL_MS)
    }

    const tail = logTail(readLog(path))
    for (const line of tail) io.err(`${line}\n`)
    // UX-17：把日志里最后一条报错单独说出来，别只让人去翻上面
    const key = [...tail].reverse().find((l) => /error|not available|EADDRINUSE|failed|失败|不可用|占用/i.test(l))?.replace(/^\s*(\[gitrader\]\s*)?error:?\s*/i, '').trim()
    io.err(key ? tr(io, `服务没能启动：${key}（完整日志在上面）\n`, `The service failed to start: ${key} (full log above)\n`) : tr(io, '服务没能启动，看上面的日志\n', 'The service failed to start; see the log above.\n'))
    killOwn(child.pid, spawn)
    return 1
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已关闭 */ }
    }
  }
}
