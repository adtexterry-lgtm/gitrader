// SPDX-License-Identifier: CPAL-1.0
// 设备密钥：32 字节随机数，参与主密钥派生（KDF 的第二个输入）。
// 没有它，拷走 keys/pin.json + keys/keystore.json 就能离线穷举 PIN；有了它，攻击者还得拿到“绑定在本机本用户上的”设备密钥。
//   Windows  用 DPAPI（CurrentUser）包裹后单独存放（keys/device.key.json）。DPAPI 经 Windows PowerShell 5.1（系统自带，不需要 pwsh 7）的一次性子进程调用：
//            只在首次设置与解锁时走一次，解出来的设备密钥缓存在内存里，**不进热路径**。别的机器 / 别的用户拿到这个文件解不开。
//   其他     macOS / Linux 先用文件权限 0600，**没有 OS 钥匙串包裹**（安全文档如实写明）；同用户读得到文件。
// 威胁模型：同一系统用户下的恶意代码（T-C）本来就能调用 DPAPI，不在保证范围；这一层防的是“只拷走了文件”（备份、同步盘、整机镜像到别的账户 / 机器）。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeProblem } from './proto'
import { KernelError } from './util/errors'
import { writeSecretFile } from './util/fsperm'
import { StateFileReader } from './util/state-file'
import type { StateFileStatus } from './util/state-file'

export interface DeviceKeyProvider {
  readonly name: 'dpapi-currentuser' | 'file-0600'
  wrap(raw: Buffer): Promise<string>
  unwrap(blob: string): Promise<Buffer>
}

/** 没有 OS 钥匙串包裹：blob 就是 base64 原文，靠文件权限（0600 / icacls）保护。 */
export const fileProvider: DeviceKeyProvider = {
  name: 'file-0600',
  wrap: async (raw) => raw.toString('base64'),
  unwrap: async (blob) => Buffer.from(blob, 'base64'),
}

const PS = (): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const SCRIPT = (fn: 'Protect' | 'Unprotect'): string =>
  `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());` +
  `$o=[System.Security.Cryptography.ProtectedData]::${fn}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($o))`

function runPs(fn: 'Protect' | 'Unprotect', inputB64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(PS(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT(fn)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const t = setTimeout(() => { c.kill(); reject(new Error('DPAPI call timed out')) }, 30_000)
    c.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    c.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
    c.on('error', (e) => { clearTimeout(t); reject(e) })
    c.on('close', (code) => { clearTimeout(t); if (code === 0 && out) resolve(out.trim()); else reject(new Error(`DPAPI ${fn} failed (${code}): ${err.trim().slice(0, 200)}`)) })
    c.stdin.end(inputB64)
  })
}

export const dpapiProvider: DeviceKeyProvider = {
  name: 'dpapi-currentuser',
  wrap: async (raw) => runPs('Protect', raw.toString('base64')),
  unwrap: async (blob) => Buffer.from(await runPs('Unprotect', blob), 'base64'),
}

export const defaultDeviceKeyProvider = (): DeviceKeyProvider => (process.platform === 'win32' ? dpapiProvider : fileProvider)

interface DeviceKeyFile { version: 1; provider: DeviceKeyProvider['name']; blob: string }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const validBlob = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length > 0 && decoded.toString('base64') === value
}
const validDeviceKeyFile = (value: unknown): value is DeviceKeyFile => isRecord(value)
  && value.version === 1
  && (value.provider === 'dpapi-currentuser' || value.provider === 'file-0600')
  && validBlob(value.blob)

export class DeviceKey {
  private cached: Buffer | null = null
  private reader: StateFileReader<DeviceKeyFile>
  constructor(private path: string, private provider: DeviceKeyProvider = defaultDeviceKeyProvider()) {
    this.reader = new StateFileReader(path, 'device-key', validDeviceKeyFile)
  }

  get providerName(): DeviceKeyProvider['name'] { return this.provider.name }
  exists(): boolean { return existsSync(this.path) }
  stateFileStatus(): StateFileStatus {
    const status = this.reader.status()
    if (status.state === 'corrupt') this.clearCache()
    return status
  }

  private clearCache(): void {
    this.cached?.fill(0)
    this.cached = null
  }

  /** 取设备密钥。create = true：不存在就生成并保存（首次设置 PIN）。内存缓存：进程内只走一次 OS 调用。 */
  async get(create: boolean): Promise<Buffer | null> {
    let f: DeviceKeyFile | null
    try { f = this.reader.read() } catch (error) { this.clearCache(); throw error }
    if (this.cached) return this.cached
    if (f) {
      if (f.provider !== this.provider.name) throw new KernelError(makeProblem('AUTH_FAILED', `device key was written by ${f.provider} and cannot be opened with the configured provider`))
      let unwrapped: Buffer
      try {
        unwrapped = await this.provider.unwrap(f.blob)
        if (unwrapped.length !== 32) throw new Error('invalid device key size')
      } catch {
        throw new KernelError(makeProblem('AUTH_FAILED', 'device key could not be opened'))
      }
      this.cached = unwrapped
      return this.cached
    }
    if (!create) return null
    const raw = randomBytes(32)
    const blob = await this.provider.wrap(raw)
    writeSecretFile(this.path, JSON.stringify({ version: 1, provider: this.provider.name, blob } satisfies DeviceKeyFile), { strict: true })
    this.reader.read()
    this.cached = raw
    return raw
  }
}
