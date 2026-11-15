// SPDX-License-Identifier: CPAL-1.0
// gitrader stop：先让服务自己优雅关闭（service.shutdown，Windows 上也有效），15 秒不退才按 PID 强制结束。
import { spawnSync } from 'node:child_process'
import { callOp as realCallOp, liveService as realLiveService, pidAlive as realPidAlive, readService as realReadService } from './index'
import type { Args, CliIo, LiveServiceInfo, ServiceInfo } from './index'

const POLL_INTERVAL_MS = 200
const GRACE_MS = 15_000
const SIGKILL_AFTER_MS = 3_000

export interface StopDeps {
  readService(home: string): ServiceInfo | null
  liveService(home: string): Promise<LiveServiceInfo | null>
  callOp(home: string, live: LiveServiceInfo, name: string, access: 'read' | 'write'): Promise<unknown>
  pidAlive(pid: number): boolean
  /** 强制结束 pid（含子进程）。Windows taskkill /T /F；unix SIGTERM，3 秒后还活着再 SIGKILL。 */
  forceKill(pid: number): Promise<void>
  now(): number
  sleep(ms: number): Promise<void>
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function realForceKill(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch { return }
  await sleepMs(SIGKILL_AFTER_MS)
  if (realPidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
}

export async function cmdStop(home: string, _a: Args, io: CliIo, deps: Partial<StopDeps> = {}): Promise<number> {
  const d: StopDeps = {
    readService: realReadService, liveService: realLiveService, callOp: realCallOp, pidAlive: realPidAlive,
    forceKill: realForceKill, now: () => Date.now(), sleep: sleepMs, ...deps,
  }
  const svc = d.readService(home)
  if (!svc || !d.pidAlive(svc.pid)) { io.out('服务没在运行\n'); return 0 }

  const live = await d.liveService(home)
  if (!live) {
    // /api/health 对不上 service.json 的 startedAt：无法确认这个进程是 gitrader（可能是进程号被复用），绝不强杀
    io.err(`service.json 里的进程 ${svc.pid} 无法确认是 gitrader（可能已被别的程序复用），没有结束它；确认后可手动结束\n`)
    return 1
  }
  try { await d.callOp(home, live, 'service.shutdown', 'read') } catch { /* 请求没送到就等超时后强制结束（已确认是 gitrader） */ }
  io.out('正在停止服务…\n')
  const deadline = d.now() + GRACE_MS
  while (d.pidAlive(svc.pid) && d.now() < deadline) await d.sleep(POLL_INTERVAL_MS)
  if (!d.pidAlive(svc.pid)) { io.out('服务已停止\n'); return 0 }

  // 超时：再核对 service.json 还是同一次启动（PID 可能已被别的进程复用），才强制结束
  const again = d.readService(home)
  if (!again || again.pid !== svc.pid || again.startedAt !== svc.startedAt) {
    io.err('服务记录已变化（可能已重启或进程号被复用），没有强制结束任何进程。请运行 gitrader status 查看\n')
    return 1
  }
  await d.forceKill(svc.pid)
  if (d.pidAlive(svc.pid)) { io.err(`强制结束失败，请手动结束进程 ${svc.pid}\n`); return 1 }
  io.out('没能正常退出，已强制结束（纸面状态可能少存最后几秒）\n')
  return 0
}
