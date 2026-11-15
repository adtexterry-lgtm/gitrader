// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto'
import { GSP_VERSION, makeProblem, validateEngineLaunch, type PluginManifest, type ProblemName } from '../../src'
import { Session, createMemoryPair, memoryTransport, remoteTransport, stdioTransport } from './transport'

export interface Target {
  kind: 'memory' | 'ws' | 'stdio'
  token: string
  tool: { tool: string; args: Record<string, unknown>; expected: unknown }
  hello(): Record<string, unknown>
  open(): Promise<Session>
  cleanup(): Promise<void>
}

const manifest: PluginManifest = {
  schema: 'gitrader-plugin/1', id: 'skill.gitrader.gsp-reference', package: 'skill', kind: 'skill',
  name: 'GSP reference', desc: 'Protocol example without trading logic', tags: ['utility'], version: '0.1.0',
  vendor: { id: 'gitrader', name: 'Gitrader', kind: 'community', verified: false },
  source: { repo: 'local/gsp-reference', commit: '0'.repeat(40), sha256: `sha256:${'0'.repeat(64)}`, fetchedAt: 1 },
  license: { spdx: 'Apache-2.0', redistribute: 'bundle', notice: 'Protocol example', commercialUse: true },
  runtime: { type: 'sidecar', native: false, diskMB: 0 }, entry: { transport: 'stdio' },
  install: { by: 'user-install', requireHashes: true }, permissions: [],
  privacy: { hosted: false, sends: [] }, provides: { tools: ['echo'] },
  tools: [{ name: 'echo', desc: 'Return an object unchanged', tags: ['utility'], input: { type: 'object' }, output: { type: 'object' } }],
  fixtures: { offline: [], smoke: [] }, compat: { gitrader: '*', pluginSchema: '1' },
}

function hasSecret(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) =>
    /^(privatekey|secret|apisecret|mnemonic|seed|passphrase|pin|password)$/.test(key.toLowerCase().replace(/[_-]/g, '')) || hasSecret(child))
}

function fake(token: string): Session {
  const [client, server] = createMemoryPair()
  let authed = false
  let closing = false
  const dispatch = (raw: unknown): unknown => {
    const m = raw as { jsonrpc?: unknown; id?: number; method?: string; params?: Record<string, unknown> }
    const error = (name: ProblemName) => {
      const data = makeProblem(name, 'request rejected')
      return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: data.code, message: data.message, data } }
    }
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return error('INVALID_REQUEST')
    const p = m.params ?? {}
    let result: unknown = { ok: true }
    if (m.method === 'plugin.hello') {
      if (p.token !== token) { closing = true; return error('AUTH_FAILED') }
      if (typeof p.gsp !== 'string' || !/^0\.1\.\d+$/.test(p.gsp)) return error('VERSION_UNSUPPORTED')
      authed = true
      result = { gsp: GSP_VERSION }
    } else {
      if (!authed) return error('AUTH_FAILED')
      if (hasSecret(p)) return error('SECRET_FIELD_REJECTED')
      if (m.method === 'plugin.describe') result = manifest
      else if (m.method === 'plugin.shutdown') closing = true
      else if (m.method === 'tool.call') {
        if (p.tool !== 'echo') return error('METHOD_NOT_FOUND')
        if (!p.args || typeof p.args !== 'object' || Array.isArray(p.args)) return error('INVALID_PARAMS')
        result = p.args
      } else if (m.method !== 'plugin.health') return error('METHOD_NOT_FOUND')
    }
    return { jsonrpc: '2.0', id: m.id, result }
  }
  server.onMessage(text => {
    const input: unknown = JSON.parse(text)
    server.send(JSON.stringify(Array.isArray(input) ? input.map(dispatch) : dispatch(input)))
    if (closing) setImmediate(() => server.close())
  })
  return new Session(memoryTransport(client))
}

export async function loadTarget(env: Record<string, string | undefined> = process.env): Promise<Target> {
  const token = env.GSP_TOKEN ?? randomBytes(24).toString('base64url')
  const sessions: Session[] = []
  let open: () => Promise<Session> = async () => fake(token)
  let kind: Target['kind'] = 'memory'
  if (env.GSP_ENDPOINT) {
    const checked = validateEngineLaunch({ url: env.GSP_ENDPOINT, auth: { method: 'token', tokenRef: 'conformance' } })
    if (!checked.ok) throw new Error('invalid GSP_ENDPOINT')
    const endpoint = env.GSP_ENDPOINT
    open = async () => new Session(await remoteTransport(endpoint))
    kind = 'ws'
  } else if (env.GSP_LAUNCH) {
    let input: unknown
    try { input = JSON.parse(env.GSP_LAUNCH) } catch { throw new Error('GSP_LAUNCH must be JSON') }
    const checked = validateEngineLaunch(input)
    if (!checked.ok || !('command' in checked.value)) throw new Error('invalid GSP_LAUNCH command')
    const launch = checked.value
    open = async () => new Session(stdioTransport(launch, token))
    kind = 'stdio'
  }
  const tool = env.GSP_TOOL_CASE ? JSON.parse(env.GSP_TOOL_CASE) as Target['tool'] : { tool: 'echo', args: { message: 'GSP round trip' }, expected: { message: 'GSP round trip' } }
  return {
    kind, token, tool,
    hello: () => ({ gsp: GSP_VERSION, token, plugin: { id: manifest.id, version: manifest.version }, permissions: [], config: {} }),
    open: async () => { const session = await open(); sessions.push(session); return session },
    cleanup: async () => { for (const session of sessions.splice(0)) await session.close() },
  }
}
