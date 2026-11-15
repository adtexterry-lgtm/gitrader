// SPDX-License-Identifier: Apache-2.0
// v0.1.2：引擎不限语言、不限跑在哪。GEP 传输三种，引擎启动配置语言无关。
//   stdio —— 本地子进程（任意语言），NDJSON；
//   ws    —— 本地 WebSocket，只允许 loopback；
//   wss   —— 远程，必须令牌或 mTLS；握手 = gep.hello（版本协商）+ engine.describe（能力协商）。
// 启动配置：本地 { command, args, env, cwd }，远程 { url, auth }。uv 只是 Python 引擎的可选便利，不是协议的一部分。
// 配置里不存任何密钥明文：令牌与证书只写句柄（tokenRef / clientCertRef），明文走内核钥匙串。

export const GEP_TRANSPORTS = ['stdio', 'ws', 'wss'] as const
export type GepTransport = (typeof GEP_TRANSPORTS)[number]

/** 本地子进程。env 只传显式列出的变量（不继承宿主环境，契约 S3）。 */
export interface EngineLaunchCommand {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export type EngineRemoteAuth =
  | { method: 'token'; /** 钥匙串里令牌的句柄，不是令牌本身。 */ tokenRef: string }
  | { method: 'mtls'; /** 客户端证书句柄。 */ clientCertRef: string; caCertRef?: string }

/** 已在运行的引擎：本地 ws（loopback）或远程 wss。 */
export interface EngineLaunchRemote {
  url: string
  auth: EngineRemoteAuth
}

export type EngineLaunch = EngineLaunchCommand | EngineLaunchRemote

export function isEngineLaunchCommand(l: EngineLaunch): l is EngineLaunchCommand {
  return 'command' in l
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

/** 远程引擎：非 loopback 的 url。界面须常驻"远程引擎"标识（契约 §2.1）。 */
export function isRemoteEngineLaunch(l: EngineLaunch): boolean {
  if (isEngineLaunchCommand(l)) return false
  try {
    return !isLoopbackHost(new URL(l.url).hostname)
  } catch {
    return true
  }
}

/** 由启动配置推断传输。 */
export function transportOfLaunch(l: EngineLaunch): GepTransport {
  if (isEngineLaunchCommand(l)) return 'stdio'
  return new URL(l.url).protocol === 'wss:' ? 'wss' : 'ws'
}

/** 启动配置检查，返回问题列表（空 = 通过）。 */
export function checkEngineLaunch(l: EngineLaunch): string[] {
  const p: string[] = []
  if (isEngineLaunchCommand(l)) {
    if (!l.command.trim()) p.push('command is empty')
    if (l.args && l.args.some((a) => typeof a !== 'string')) p.push('args must be strings')
    if (l.env && Object.values(l.env).some((v) => typeof v !== 'string')) p.push('env values must be strings')
    return p
  }
  let u: URL
  try {
    u = new URL(l.url)
  } catch {
    return ['url is not a valid URL']
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') p.push(`unsupported scheme ${u.protocol} (expected ws: or wss:)`)
  if (u.username || u.password || /[?&](token|auth|key)=/i.test(u.search)) p.push('credentials must not be placed in the URL; the token goes in gep.hello params')
  if (!isLoopbackHost(u.hostname) && u.protocol !== 'wss:') p.push('non-loopback engines must use wss://')
  if (!l.auth || (l.auth.method !== 'token' && l.auth.method !== 'mtls')) p.push('auth is required: token or mtls')
  else if (l.auth.method === 'token' && !l.auth.tokenRef) p.push('token auth requires tokenRef')
  else if (l.auth.method === 'mtls' && !l.auth.clientCertRef) p.push('mtls auth requires clientCertRef')
  return p
}
