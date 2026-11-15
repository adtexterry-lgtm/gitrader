// SPDX-License-Identifier: Apache-2.0
// 被测目标：由环境变量决定。
//   GEP_ENDPOINT   ws:// 或 wss:// 地址（引擎已在运行）
//   GEP_LAUNCH     JSON：{"command":"…","args":[…],"env":{…},"cwd":"…"}（套件起子进程，stdio/NDJSON；任意语言）
//   GEP_TOKEN      令牌（默认 conformance-token）
//   GEP_EVENT_VOLUME  T08 / T12 的事件量（默认 10000）
//   GEP_REPORT_PATH   写 gep-conformance-report.json 的位置
// 两个都没设 → 自测模式：对内存假引擎运行（套件自己的健康检查）。
// 对真引擎运行时请关闭文件并行：vitest run --fileParallelism=false（它们共用同一个引擎）。
import { checkEngineLaunch, validateEngineLaunch, type EngineLaunchCommand } from '../src'
import { FakeEngine, type FakeEngineOptions } from './fake-engine'
import { HostSim } from './host-sim'
import { GepSession } from './session'
import { createMemoryPair, memoryTransport, stdioTransport, wsTransport } from './transport'

export interface Timing {
  /** 停发心跳后等多久再断言"不再开仓"（契约：15 s 判定断线）。 */
  heartbeatLossWaitMs: number
  /** T12 停发 ack 的时长（契约：30 s）。 */
  backpressureWaitMs: number
  /** 断线多久后续传（契约：3 s）。 */
  reconnectAfterMs: number
  /** A1 观察"拆单规避"的窗口（契约：60 s）。 */
  splitWatchMs: number
  /** 喂完事件后给引擎的反应时间。 */
  settleMs: number
  /** 事件量。 */
  eventVolume: number
}

export interface Target {
  kind: 'fake' | 'ws' | 'stdio'
  label: string
  token: string
  timing: Timing
  host: HostSim
  /** 开一条新会话（清空宿主仿真的记录；fake 每次是全新引擎）。 */
  open(): Promise<GepSession>
  /** 在同一个引擎上开新连接用于续传；不能续传（stdio 进程随连接结束）返回 null。 */
  reopen(prev: GepSession): Promise<GepSession | null>
  cleanup(): Promise<void>
}

export interface LoadOptions { fake?: FakeEngineOptions }

export async function loadTarget(opts: LoadOptions = {}): Promise<Target> {
  const token = process.env['GEP_TOKEN'] ?? 'conformance-token'
  const volume = Number(process.env['GEP_EVENT_VOLUME'] ?? 10_000)
  const host = new HostSim()
  const sessions: GepSession[] = []
  const track = (s: GepSession): GepSession => { sessions.push(s); return s }
  const cleanup = async (): Promise<void> => { for (const s of sessions) s.close() }

  const endpoint = process.env['GEP_ENDPOINT']
  if (endpoint) {
    const timing: Timing = { heartbeatLossWaitMs: 18_000, backpressureWaitMs: 30_000, reconnectAfterMs: 3_000, splitWatchMs: 60_000, settleMs: 400, eventVolume: volume }
    return {
      kind: 'ws', label: endpoint, token, timing, host,
      open: async () => { host.clear(); return track(new GepSession(await wsTransport(endpoint), host)) },
      reopen: async () => track(new GepSession(await wsTransport(endpoint), host)),
      cleanup,
    }
  }

  const launchJson = process.env['GEP_LAUNCH']
  if (launchJson) {
    const launch = JSON.parse(launchJson) as EngineLaunchCommand
    const v = validateEngineLaunch(launch)
    if (!v.ok || checkEngineLaunch(launch).length > 0) throw new Error(`GEP_LAUNCH is not a valid engine launch config: ${JSON.stringify(v)}`)
    const timing: Timing = { heartbeatLossWaitMs: 18_000, backpressureWaitMs: 30_000, reconnectAfterMs: 3_000, splitWatchMs: 60_000, settleMs: 400, eventVolume: volume }
    return {
      kind: 'stdio', label: `${launch.command} ${(launch.args ?? []).join(' ')}`.trim(), token, timing, host,
      open: async () => { host.clear(); return track(new GepSession(stdioTransport(launch, token), host)) },
      reopen: async () => null,
      cleanup,
    }
  }

  // 自测：内存假引擎，缩短所有等待
  const timing: Timing = { heartbeatLossWaitMs: 1_200, backpressureWaitMs: 300, reconnectAfterMs: 300, splitWatchMs: 800, settleMs: 60, eventVolume: volume }
  let engine: FakeEngine | undefined
  const connect = (fresh: boolean): GepSession => {
    if (fresh || !engine) engine = new FakeEngine({ token, heartbeatTimeoutMs: 600, ...(opts.fake ?? {}) })
    const [clientEnd, serverEnd] = createMemoryPair()
    engine.accept(serverEnd)
    return track(new GepSession(memoryTransport(clientEnd), host))
  }
  return {
    kind: 'fake', label: 'in-memory fake engine', token, timing, host,
    open: async () => { host.clear(); return connect(true) },
    reopen: async () => connect(false),
    cleanup,
  }
}
