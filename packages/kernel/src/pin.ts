// SPDX-License-Identifier: CPAL-1.0
// 本机 PIN：在场证明的后备方式（通行密钥为主，M1.1 再做）。
// scrypt 哈希存储；失败指数退避（持久化，重启不清零）；PIN 不进日志、不进账本、不进错误信息。
// 同一次 scrypt 派生出 32 字节主密钥：既当 PIN 校验值，也当密钥库的加密主密钥（解锁后只在内存）。
import { randomBytes, scrypt as scryptCb, createHash, hkdfSync } from 'node:crypto'
import { PIN_PATTERN, makeProblem } from './proto'
import type { DeviceKey } from './device-key'
import { KernelError } from './util/errors'
import { safeEqual } from './util/hash'
import { writeSecretFile } from './util/fsperm'
import type { Clock } from './util/clock'
import { StateFileReader } from './util/state-file'
import type { StateFileStatus } from './util/state-file'
import { STATE_FILE_CORRUPT_MESSAGE } from './util/state-file'

export interface ScryptParams { N: number; r: number; p: number }
/** N = 2^17（约 128 MB 内存、单次约 0.3–0.6 s）：把离线穷举的单价抬高 4 倍；再加设备密钥，光拷走文件不够。 */
export const DEFAULT_SCRYPT: ScryptParams = { N: 1 << 17, r: 8, p: 1 }
/** PIN 格式（UI 线格式 v0.1.3）：6–12 位数字。 */
/** 口令格式：6–12 位数字的 PIN（UI 线格式 v0.1.3），或 8–64 位任意字符的口令。界面仍叫 PIN；越长越安全。 */
export const PIN_MIN_LENGTH = 6
export const PIN_MAX_LENGTH = 64
export const isAcceptablePin = (pin: unknown): pin is string => typeof pin === 'string' && (new RegExp(PIN_PATTERN).test(pin) || (pin.length >= 8 && pin.length <= PIN_MAX_LENGTH))
/** 提示（不阻止）：纯数字的 PIN 很容易被穷举，建议更长 / 带字母。 */
export const pinHint = (pin: string): string | undefined => (/^[0-9]+$/.test(pin) && pin.length < 10 ? 'A longer PIN is safer: use 10+ digits or a passphrase of 8-64 characters.' : undefined)
/** 设置 PIN 时的即时格式校验：合规返回 undefined，否则返回中文原因。 */
export function validatePinShape(pin: string): string | undefined {
  return isAcceptablePin(pin) ? undefined : 'PIN 要 6–12 位数字，或 8–64 位的口令'
}
/** 常见弱 PIN：全同数字、任意升序 / 降序连号（长度 ≥ 6）。 */
export function isWeakPin(pin: string): boolean {
  if (!/^[0-9]{6,}$/.test(pin)) return false
  if (/^([0-9])\1*$/.test(pin)) return true
  let ascending = true
  let descending = true
  for (let i = 1; i < pin.length; i++) {
    const d = pin.charCodeAt(i) - pin.charCodeAt(i - 1)
    if (d !== 1) ascending = false
    if (d !== -1) descending = false
  }
  return ascending || descending
}
/** 失败 3 次后开始锁定：1 s、2 s、4 s … 封顶 15 分钟。 */
export const PIN_FREE_ATTEMPTS = 3
export const PIN_LOCK_CAP_MS = 15 * 60 * 1000

interface PinFile {
  /** 1 = 旧格式（只有 PIN 的 scrypt）；2 = scrypt 输出再与设备密钥 HKDF 合并。 */
  version: 1 | 2
  kdf: { name: 'scrypt'; salt: string } & ScryptParams
  verifier: string
  createdAt: number
  failures: number
  lockedUntil: number
}

const derive = (pin: string, salt: Buffer, prm: ScryptParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(pin.normalize('NFKC'), salt, 32, { N: prm.N, r: prm.r, p: prm.p, maxmem: 256 * prm.N * prm.r }, (err, key) => (err ? reject(err) : resolve(key)))
  })
/** scrypt 输出 + 设备密钥 → 主密钥。没有设备密钥文件，光有 PIN 派生不出主密钥。 */
const combine = (pinKey: Buffer, device: Buffer): Buffer => Buffer.from(hkdfSync('sha256', pinKey, device, 'gitrader-master/1', 32))
const verifierOf = (key: Buffer): string => createHash('sha256').update('gitrader-pin-verify/1').update(key).digest('base64')

const authFailed = (message: string, extra: { retryAfterMs?: number } = {}): KernelError =>
  new KernelError(makeProblem('AUTH_FAILED', message, { retryable: extra.retryAfterMs !== undefined, ...extra }))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const validB64 = (value: unknown, bytes: number): value is string => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === bytes && decoded.toString('base64') === value
}
const safeCounter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function validPinFile(value: unknown): value is PinFile {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !isRecord(value.kdf)) return false
  const { kdf } = value
  return kdf.name === 'scrypt' && validB64(kdf.salt, 16)
    && Number.isSafeInteger(kdf.N) && (kdf.N as number) >= 1024 && (kdf.N as number) <= 1_048_576 && ((kdf.N as number) & ((kdf.N as number) - 1)) === 0
    && Number.isSafeInteger(kdf.r) && (kdf.r as number) > 0 && (kdf.r as number) <= 32
    && Number.isSafeInteger(kdf.p) && (kdf.p as number) > 0 && (kdf.p as number) <= 16
    && validB64(value.verifier, 32) && safeCounter(value.createdAt) && safeCounter(value.failures) && safeCounter(value.lockedUntil)
}
const stateCorrupt = (error: unknown): boolean => error instanceof KernelError && error.problem.name === 'STATE_FILE_CORRUPT'
const stateFileCorrupt = (): KernelError => new KernelError(makeProblem('STATE_FILE_CORRUPT', STATE_FILE_CORRUPT_MESSAGE))

export class PinStore {
  private dependencyCorrupt = false
  /**
   * 集成修补（H，v2 复验）：旧格式（version 1：只有 PIN 的 scrypt、旧参数、没有设备密钥）验证通过时就地升级成 version 2。
   * 主密钥会变，所以由内核注入的回调先用新旧主密钥给密钥库换钥；回调失败（或没有设备密钥）就保持原样、照常放行，下次再试。
   */
  onLegacyUpgrade?: (oldKey: Buffer, newKey: Buffer) => void
  private reader: StateFileReader<PinFile>
  constructor(private path: string, private clock: Clock, private params: ScryptParams = DEFAULT_SCRYPT, private device?: DeviceKey) {
    this.reader = new StateFileReader(path, 'pin', validPinFile)
  }

  /** 文件格式版本（未设置 = null）。 */
  version(): 1 | 2 | null { return this.read()?.version ?? null }

  private async upgradeLegacy(pin: string, f: PinFile, oldKey: Buffer): Promise<Buffer> {
    if (f.version !== 1 || !this.device || !this.onLegacyUpgrade) return oldKey
    try {
      const salt = randomBytes(16)
      const dk = await this.device.get(true)
      if (!dk) return oldKey
      const newKey = combine(await derive(pin, salt, this.params), dk)
      this.onLegacyUpgrade(oldKey, newKey) // 先换钥：失败就不写新 pin.json，旧文件仍能解开旧密文
      this.write({ ...f, version: 2, kdf: { name: 'scrypt', salt: salt.toString('base64'), ...this.params }, verifier: verifierOf(newKey), failures: 0, lockedUntil: 0 })
      return newKey
    } catch (error) { if (stateCorrupt(error)) throw error; return oldKey }
  }

  private read(): PinFile | null { return this.reader.read() }
  private write(f: PinFile): void {
    writeSecretFile(this.path, JSON.stringify(f), { strict: true })
    this.read()
  }

  isSet(): boolean {
    if (this.dependencyCorrupt) throw stateFileCorrupt()
    return this.reader.status().state !== 'missing'
  }

  stateFileStatus(): StateFileStatus { return this.reader.status() }
  deviceStateFileStatus(): StateFileStatus { return this.device?.stateFileStatus() ?? { kind: 'device-key', state: 'missing' } }
  markStateCorrupt(): void { this.dependencyCorrupt = true; this.reader.latchCorruption() }

  status(): { set: boolean; failures: number; lockedUntil: number } {
    const state = this.reader.status()
    if (state.state === 'corrupt') return { set: true, failures: 0, lockedUntil: Number.MAX_SAFE_INTEGER }
    const f = this.read()
    return { set: f !== null, failures: f?.failures ?? 0, lockedUntil: f?.lockedUntil ?? 0 }
  }

  /** 首次设置；已设置则拒绝（改 PIN 走 change，需要旧 PIN）。返回主密钥。 */
  async setup(pin: string): Promise<Buffer> {
    if (this.read()) throw authFailed('PIN already set')
    this.checkFormat(pin)
    const salt = randomBytes(16)
    let key = await derive(pin, salt, this.params)
    if (this.device) key = combine(key, (await this.device.get(true))!)
    this.write({ version: this.device ? 2 : 1, kdf: { name: 'scrypt', salt: salt.toString('base64'), ...this.params }, verifier: verifierOf(key), createdAt: this.clock.now(), failures: 0, lockedUntil: 0 })
    return key
  }

  /** 校验 PIN，成功返回主密钥。锁定期内直接拒绝（连正确 PIN 也不评估）。 */
  async verify(pin: string): Promise<Buffer> {
    const f = this.read()
    if (!f) throw authFailed('PIN not set')
    const now = this.clock.now()
    if (f.lockedUntil > now) throw authFailed('too many failed PIN attempts', { retryAfterMs: f.lockedUntil - now })
    let ok = false
    let key: Buffer | undefined
    if (typeof pin === 'string' && pin.length > 0 && pin.length <= PIN_MAX_LENGTH) {
      key = await derive(pin, Buffer.from(f.kdf.salt, 'base64'), f.kdf)
      if (f.version === 2) {
        const dk = await this.device?.get(false)
        if (!dk) throw authFailed('the device key for this keystore is missing (the keys/ files were copied without it); restore keys/device.key.json')
        key = combine(key, dk)
      }
      ok = safeEqual(verifierOf(key), f.verifier)
    }
    if (ok && key) {
      if (f.failures !== 0 || f.lockedUntil !== 0) this.write({ ...f, failures: 0, lockedUntil: 0 })
      if (f.version === 1) return this.upgradeLegacy(pin, { ...f, failures: 0, lockedUntil: 0 }, key)
      return key
    }
    const failures = f.failures + 1
    const lockMs = failures > PIN_FREE_ATTEMPTS ? Math.min(2 ** (failures - PIN_FREE_ATTEMPTS - 1) * 1000, PIN_LOCK_CAP_MS) : 0
    this.write({ ...f, failures, lockedUntil: lockMs ? this.clock.now() + lockMs : 0 })
    throw authFailed('invalid PIN', lockMs ? { retryAfterMs: lockMs } : {})
  }

  /** 修改 PIN：必须先用旧 PIN 通过校验（带失败退避）。返回新旧主密钥，调用方据此给密钥库换钥。 */
  async change(oldPin: string, newPin: string): Promise<{ oldKey: Buffer; newKey: Buffer }> {
    const oldKey = await this.verify(oldPin)
    this.checkFormat(newPin)
    const f = this.read()!
    const salt = randomBytes(16)
    let newKey = await derive(newPin, salt, this.params)
    if (f.version === 2 && this.device) newKey = combine(newKey, (await this.device.get(false))!)
    this.write({ ...f, kdf: { name: 'scrypt', salt: salt.toString('base64'), ...this.params }, verifier: verifierOf(newKey), failures: 0, lockedUntil: 0 })
    return { oldKey, newKey }
  }

  private checkFormat(pin: string): void {
    if (!isAcceptablePin(pin)) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'PIN must be 6-12 digits, or a passphrase of 8-64 characters'))
    }
  }
}
