// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：进程内的 EngineCore + 协议包一致性套件的「假宿主」（内存传输），不碰网络、不起子进程。
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineCore, type EngineCoreOptions } from '../src/runtime/engine'
import { GepSession } from '../../protocol/conformance/session'
import { HostSim, PAPER_ACCOUNT, MANDATE_ID, BTC } from '../../protocol/conformance/host-sim'
import { createMemoryPair, memoryTransport } from '../../protocol/conformance/transport'
import { GEP_LIMITS } from '../src/proto'

export const TOKEN = 'test-token-0000'
export { PAPER_ACCOUNT, MANDATE_ID, BTC }

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_STRATEGIES = join(here, 'fixtures', 'strategies')
export const EXAMPLE_STRATEGIES = join(here, '..', 'examples', 'strategies')

/** 新建一个策略文件夹并放进指定的夹具 / 示例文件（引擎本身不带策略，测试要自己「安装」）。 */
export function strategyDir(files: string[] = [join(FIXTURE_STRATEGIES, 'ema-cross.ts')]): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-strategies-'))
  for (const f of files) copyFileSync(f, join(dir, basename(f)))
  return dir
}

export interface Rig {
  core: EngineCore
  session: GepSession
  host: HostSim
  close(): void
}

/** 起一个引擎并用内存传输接上假宿主；完成 hello（可关）。 */
export async function rig(opts: Partial<EngineCoreOptions> & { hello?: boolean; heartbeats?: boolean } = {}): Promise<Rig> {
  const { hello = true, heartbeats = true, ...coreOpts } = opts
  const core = new EngineCore({ token: TOKEN, tickMs: 50, heartbeatMs: 1000, strategiesDir: strategyDir(), ...coreOpts })
  await core.ready
  const [engineEnd, hostEnd] = createMemoryPair()
  const conn = core.connect({ kind: 'memory', send: (t) => engineEnd.send(t), closeTransport: () => engineEnd.close(), maxFrameBytes: GEP_LIMITS.maxWsFrameBytes })
  engineEnd.onMessage((t) => { void conn.peer.receive(t) })
  engineEnd.onClose(() => core.disconnect(conn))
  const host = new HostSim()
  const session = new GepSession(memoryTransport(hostEnd), host)
  if (hello) {
    const o = await session.hello({ token: TOKEN })
    if (!o.ok) throw new Error(`hello failed: ${JSON.stringify(o.error)}`)
    if (heartbeats) session.startHeartbeats(500)
  }
  return { core, session, host, close: () => { session.close(); core.close() } }
}

export async function bindPaper(r: Rig, heartbeatMs = 1000): Promise<void> {
  await r.session.call('engine.bind', {
    bindingId: 'bind_01JABA', accounts: [{ accountId: PAPER_ACCOUNT, mode: 'A', mandateId: MANDATE_ID }],
    data: { source: 'host', instruments: [BTC] }, policies: [], heartbeatMs,
  })
}
