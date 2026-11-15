// SPDX-License-Identifier: CPAL-1.0
// GSP uses the engine supervisor's existing ws client, authentication and reconnect policy.
import { EngineSupervisor, type EngineHandle, type EngineSupervisorOptions } from './engines'
import { EventBus } from './events'
import { checkEngineLaunch, makeProblem, validateEngineLaunch } from './proto'
import type { EngineLaunch, PluginManifest } from './proto'
import { KernelError } from './util/errors'

export function pluginLaunch(m: PluginManifest): EngineLaunch | undefined {
  const remote = m.entry?.transport === 'ws' || m.entry?.transport === 'wss'
  const extension = (m as unknown as Record<string, unknown>)['x-launch']
  if (!remote && m.runtime.type === 'node') return undefined
  if (!remote && !['sidecar', 'python-sidecar'].includes(m.runtime.type)) {
    throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'runtime does not support GSP'))
  }
  if (!remote && extension === undefined) {
    throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', 'sidecar GSP requires x-launch'))
  }
  const input = remote
    ? { url: m.entry?.url, auth: { method: 'token', tokenRef: `env:GITRADER_PLUGIN_TOKEN_${m.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` } }
    : extension
  const checked = validateEngineLaunch(input)
  if (!checked.ok || checkEngineLaunch(checked.value).length) {
    throw new KernelError(makeProblem('INVALID_PARAMS', 'invalid GSP x-launch configuration'))
  }
  const launch = checked.value
  if (remote) {
    if (!('url' in launch) || new URL(launch.url).protocol !== `${m.entry!.transport}:`) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'entry transport must match its URL'))
    }
  } else if (!('command' in launch) || (m.entry?.transport && m.entry.transport !== 'stdio')) {
    throw new KernelError(makeProblem('INVALID_PARAMS', 'local GSP requires a command and stdio'))
  }
  return launch
}

export class RemotePluginTransport {
  private supervisor: EngineSupervisor
  private tick?: ReturnType<typeof setInterval>
  private unsubscribe?: () => void

  constructor(id: string, launch: Extract<EngineLaunch, { url: string }>, opts: Omit<EngineSupervisorOptions, 'events'> & {
    connected(handle: EngineHandle, token: string): void
    disconnected(): void
    state(state: string, detail?: string): void
  }) {
    const events = new EventBus(() => opts.clock.now())
    events.subscribe('engine.health', event => {
      const data = event.data as { state: string; detail?: string }
      opts.state(data.state, data.detail)
    })
    this.supervisor = new EngineSupervisor({ ...opts, events })
    this.supervisor.load([{ id, enabled: true, launch }])
    this.supervisor.onConnected((_id, handle, token) => {
      this.unsubscribe?.()
      opts.connected({
        ...handle,
        ...(handle.kind === 'ws' ? { onMessage: (cb: (text: string) => void) => {
          this.unsubscribe = handle.onMessage(cb)
          return this.unsubscribe
        } } : {}),
      }, token)
    })
    this.supervisor.onDisconnected(() => {
      this.unsubscribe?.()
      this.unsubscribe = undefined
      opts.disconnected()
    })
  }

  start(id: string): void {
    this.tick = setInterval(() => this.supervisor.tick(), 1000)
    this.tick.unref?.()
    this.supervisor.start(id)
  }

  async stop(id: string): Promise<void> {
    clearInterval(this.tick)
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.supervisor.stop(id)
  }
}
