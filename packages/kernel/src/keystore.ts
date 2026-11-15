// SPDX-License-Identifier: CPAL-1.0
// 密钥库：API 钱包私钥静态加密（AES-256-GCM），主密钥由 PIN 经 scrypt 派生，解锁后只在内存。
// 对外只暴露"签名器句柄"（signTypedData 形状）：连接器拿得到签名、拿不到私钥明文；明文只在一次签名的栈帧里存在并立即清零。
// TODO(DPAPI): Windows DPAPI 包裹主密钥作为第二层，不进热路径（记忆教训：DPAPI 子进程会把热路径拖超时）。
// 只交易不提现：这里只存 API 钱包（HL 的 API 钱包天然无提现权限，≤180 天有效期，到期提醒与轮换，旧地址不复用）。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { makeProblem } from './proto'
import { assertProof } from './auth'
import type { HumanProof } from './auth'
import { addressOf, signTypedDataWithKey } from './eip712'
import type { TypedData } from './eip712'
import { KernelError } from './util/errors'
import { writeSecretFile } from './util/fsperm'
import { ulid } from './util/ids'
import type { Clock } from './util/clock'
import { StateFileReader } from './util/state-file'
import type { StateFileStatus } from './util/state-file'

const DAY = 86_400_000
export const WALLET_MAX_VALIDITY_DAYS = 180

interface Enc { iv: string; tag: string; ct: string }
export interface WalletRecord {
  walletId: string
  name: string
  kind: 'api-wallet'
  venue: string
  /** 创建时所在的网络（主网 / 测试网）。 */
  network: 'mainnet' | 'testnet'
  address: string
  createdAt: number
  notAfter: number
  revokedAt: number | null
  enc: Enc
}
interface KeystoreFile { version: 1; check: Enc; wallets: WalletRecord[] }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isSafeTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isB64 = (value: unknown, length?: number): value is string => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value && (length === undefined || decoded.length === length)
}
const validEnc = (value: unknown): value is Enc => isRecord(value)
  && isB64(value.iv, 12) && isB64(value.tag, 16) && isB64(value.ct) && Buffer.from(value.ct as string, 'base64').length > 0
const validWallet = (value: unknown): value is WalletRecord => isRecord(value)
  && typeof value.walletId === 'string' && value.walletId.length > 0
  && typeof value.name === 'string' && value.name.length > 0
  && value.kind === 'api-wallet'
  && typeof value.venue === 'string' && value.venue.length > 0
  && (value.network === 'mainnet' || value.network === 'testnet')
  && typeof value.address === 'string' && value.address.length > 0
  && isSafeTime(value.createdAt) && isSafeTime(value.notAfter)
  && (value.revokedAt === null || isSafeTime(value.revokedAt))
  && validEnc(value.enc)
const validKeystoreFile = (value: unknown): value is KeystoreFile => isRecord(value)
  && value.version === 1 && validEnc(value.check) && Array.isArray(value.wallets) && value.wallets.every(validWallet)

/** 对外可见的钱包信息：名称 / 地址 / 到期 / 撤销。没有任何密钥字段。 */
export interface WalletInfo {
  walletId: string
  name: string
  kind: 'api-wallet'
  venue: string
  network: 'mainnet' | 'testnet'
  address: string
  createdAt: number
  notAfter: number
  revokedAt: number | null
  status: 'active' | 'expired' | 'revoked'
  /** 距到期天数（向下取整，已到期为 0）。 */
  expiresInDays: number
  /** ≤ warnDays 天内到期（提醒字段，界面据此提示轮换）。 */
  expiringSoon: boolean
}

export interface Signer {
  readonly walletId: string
  readonly address: string
  /** viem / @nktkas/hyperliquid 钱包对象的 signTypedData 形状；返回 0x 十六进制签名。 */
  signTypedData(td: TypedData): Promise<string>
}

export interface SignedInfo { walletId: string; address: string; digest: string; primaryType: string }

const seal = (key: Buffer, plain: Uint8Array, aad: string): Enc => {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }
}
const open = (key: Buffer, e: Enc, aad: string): Buffer => {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(e.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()])
}

const err = (name: 'AUTH_FAILED' | 'INVALID_PARAMS' | 'ACCOUNT_NOT_BOUND', message: string): KernelError => new KernelError(makeProblem(name, message))

export class Keystore {
  private master: Buffer | null = null
  private reader: StateFileReader<KeystoreFile>

  constructor(
    private path: string,
    private clock: Clock,
    private opts: { warnDays?: number; onSigned?: (s: SignedInfo) => void; assertStateHealthy?: () => void } = {},
  ) { this.reader = new StateFileReader(path, 'keystore', validKeystoreFile) }

  private read(): KeystoreFile | null {
    try { return this.reader.read() } catch (error) {
      if (error instanceof KernelError && error.problem.name === 'STATE_FILE_CORRUPT') this.lock()
      throw error
    }
  }
  private write(f: KeystoreFile): void {
    writeSecretFile(this.path, JSON.stringify(f), { strict: true })
    this.read()
  }

  stateFileStatus(): StateFileStatus {
    const status = this.reader.status()
    if (status.state === 'corrupt') this.lock()
    return status
  }

  isUnlocked(): boolean {
    return this.stateFileStatus().state !== 'corrupt' && this.master !== null
  }

  /** 解锁：需要 PIN 在场证明（证明里带 scrypt 派生出的主密钥）。 */
  unlock(proof: HumanProof): void {
    this.opts.assertStateHealthy?.()
    const p = assertProof(proof, 'pin')
    if (!p.masterKey) throw err('AUTH_FAILED', 'PIN proof carries no key material')
    const f = this.read()
    if (f) {
      try { open(p.masterKey, f.check, 'keystore-check') } catch { throw this.corruptByCheck() }
    }
    this.master = Buffer.from(p.masterKey)
  }

  private corruptByCheck(): KernelError {
    this.reader.latchCorruption()   // 之后 stateFileStatus() = corrupt → securityStateHealth 锁存 → /api/health 与 doctor「安全」项变红
    this.lock()
    return new KernelError(makeProblem('STATE_FILE_CORRUPT',
      'keystore.json failed its integrity check although the PIN is correct (edited, replaced by another copy, or an interrupted PIN change); restore the original file, or stop the service and run gitrader pin reset. ' +
      '钥匙库文件校验没通过——PIN 本身是对的：文件被改过、被别的备份顶替，或改 PIN 中途中断。从备份还原；或先停掉服务再运行 gitrader pin reset'))
  }

  lock(): void {
    if (this.master) this.master.fill(0)
    this.master = null
  }

  private requireUnlocked(): Buffer {
    this.opts.assertStateHealthy?.()
    this.read()
    if (!this.master) throw err('AUTH_FAILED', 'keystore is locked')
    return this.master
  }

  private file(): KeystoreFile {
    const f = this.read()
    if (f) return f
    return { version: 1, check: seal(this.requireUnlocked(), Buffer.from('gitrader-keystore'), 'keystore-check'), wallets: [] }
  }

  private info(w: WalletRecord): WalletInfo {
    const now = this.clock.now()
    const status = w.revokedAt !== null ? 'revoked' : w.notAfter <= now ? 'expired' : 'active'
    const expiresInDays = Math.max(0, Math.floor((w.notAfter - now) / DAY))
    return {
      walletId: w.walletId, name: w.name, kind: w.kind, venue: w.venue, network: w.network ?? 'testnet', address: w.address, createdAt: w.createdAt, notAfter: w.notAfter,
      revokedAt: w.revokedAt, status, expiresInDays, expiringSoon: status === 'active' && w.notAfter - now <= (this.opts.warnDays ?? 14) * DAY,
    }
  }

  /** 列表不需要解锁（只含名称 / 地址 / 到期 / 撤销）。 */
  list(): WalletInfo[] { return (this.read()?.wallets ?? []).map((w) => this.info(w)) }

  private add(proof: HumanProof, input: { name: string; venue?: string; network?: 'mainnet' | 'testnet'; validityDays?: number; notAfter?: number }, sk: Uint8Array): WalletInfo {
    assertProof(proof, 'session') // 契约 §5.1：导入凭据会话即可；密钥库已解锁（解锁本身走 PIN）
    const master = this.requireUnlocked()
    const name = String(input.name ?? '').trim()
    if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(name)) throw err('INVALID_PARAMS', 'wallet name must be 1-40 characters (letters, digits, space, . _ -)')
    const f = this.file()
    const address = addressOf(sk)
    if (f.wallets.some((w) => w.name === name)) throw err('INVALID_PARAMS', `wallet name already used: ${name}`)
    if (f.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) throw err('INVALID_PARAMS', 'this API wallet is already in the keystore (an address is never reused)')
    const now = this.clock.now()
    const notAfter = input.notAfter ?? now + Math.min(input.validityDays ?? WALLET_MAX_VALIDITY_DAYS, WALLET_MAX_VALIDITY_DAYS) * DAY
    if (!(notAfter > now) || notAfter > now + WALLET_MAX_VALIDITY_DAYS * DAY) throw err('INVALID_PARAMS', `notAfter must be within ${WALLET_MAX_VALIDITY_DAYS} days from now`)
    const walletId = `wal_${ulid(now)}`
    const rec: WalletRecord = {
      walletId, name, kind: 'api-wallet', venue: input.venue ?? 'hyperliquid', network: input.network ?? 'testnet', address, createdAt: now, notAfter, revokedAt: null,
      enc: seal(master, sk, `wallet:${walletId}`),
    }
    f.wallets.push(rec)
    this.write(f)
    return this.info(rec)
  }

  /** 生成新的 API 钱包。返回地址等公开信息；私钥永不返回（用户用地址去主钱包做 approveAgent）。 */
  generate(proof: HumanProof, input: { name: string; venue?: string; network?: 'mainnet' | 'testnet'; validityDays?: number }): WalletInfo {
    const sk = secp256k1.utils.randomSecretKey()
    try { return this.add(proof, input, sk) } finally { sk.fill(0) }
  }

  /** 导入已有 API 钱包私钥（十六进制）。私钥只在这次调用里经过内存，不进日志与账本。 */
  import(proof: HumanProof, input: { name: string; privateKey: string; venue?: string; network?: 'mainnet' | 'testnet'; validityDays?: number; notAfter?: number }): WalletInfo {
    const s = String(input.privateKey ?? '').trim().replace(/^0x/i, '')
    if (!/^[0-9a-fA-F]{64}$/.test(s)) throw err('INVALID_PARAMS', 'private key must be 32 bytes of hex')
    const sk = hexToBytes(s)
    try {
      if (!secp256k1.utils.isValidSecretKey(sk)) throw err('INVALID_PARAMS', 'not a valid secp256k1 private key')
      return this.add(proof, input, sk)
    } finally { sk.fill(0) }
  }

  /** 修改 PIN 之后给全部钱包换钥（旧主密钥解、新主密钥封），并把内存里的主密钥换成新的。 */
  rekey(oldMaster: Buffer, newMaster: Buffer): void {
    const f = this.read()
    if (f) {
      try {
        for (const w of f.wallets) w.enc = seal(newMaster, open(oldMaster, w.enc, `wallet:${w.walletId}`), `wallet:${w.walletId}`)
        f.check = seal(newMaster, Buffer.from('gitrader-keystore'), 'keystore-check')
        this.write(f)
      } catch {
        throw this.corruptByCheck()
      }
    }
    if (this.master) this.master.fill(0)
    this.master = Buffer.from(newMaster)
  }

  /** 撤销只需会话（不需要 PIN）：撤销之后签名器立刻失效。 */
  revoke(proof: HumanProof, walletId: string): WalletInfo {
    assertProof(proof, 'session')
    const f = this.read()
    const w = f?.wallets.find((x) => x.walletId === walletId || x.name === walletId)
    if (!f || !w) throw err('ACCOUNT_NOT_BOUND', `no such wallet: ${walletId}`)
    if (w.revokedAt === null) { w.revokedAt = this.clock.now(); this.write(f) }
    return this.info(w)
  }

  /** 签名器句柄。钱包必须有效（未撤销、未过期）且密钥库已解锁。 */
  getSigner(walletIdOrName: string): Signer {
    this.opts.assertStateHealthy?.()
    const f = this.read()
    const w = f?.wallets.find((x) => x.walletId === walletIdOrName || x.name === walletIdOrName)
    if (!w) throw err('ACCOUNT_NOT_BOUND', `no such wallet: ${walletIdOrName}`)
    if (w.revokedAt !== null) throw err('AUTH_FAILED', `wallet ${w.name} is revoked`)
    if (w.notAfter <= this.clock.now()) throw err('AUTH_FAILED', `wallet ${w.name} expired: rotate the API wallet`)
    const self = this
    return {
      walletId: w.walletId,
      address: w.address,
      async signTypedData(td: TypedData): Promise<string> {
        const cur = self.read()?.wallets.find((x) => x.walletId === w.walletId)
        if (!cur || cur.revokedAt !== null) throw err('AUTH_FAILED', 'wallet revoked')
        if (cur.notAfter <= self.clock.now()) throw err('AUTH_FAILED', 'wallet expired: rotate the API wallet')
        const master = self.requireUnlocked()
        let sk: Uint8Array
        try {
          sk = open(master, cur.enc, `wallet:${cur.walletId}`)
        } catch {
          throw self.corruptByCheck()
        }
        try {
          const { signature, digest } = signTypedDataWithKey(td, sk)
          self.opts.onSigned?.({ walletId: cur.walletId, address: cur.address, digest, primaryType: td.primaryType })
          return signature
        } finally { sk.fill(0) }
      },
    }
  }

  /** 文件内容是否含明文私钥（测试用断言：静态加密）。 */
  static fileLeaks(path: string, privateKeyHex: string): boolean {
    if (!existsSync(path)) return false
    const raw = readFileSync(path, 'utf8').toLowerCase()
    const k = privateKeyHex.replace(/^0x/i, '').toLowerCase()
    return raw.includes(k) || raw.includes(Buffer.from(hexToBytes(k)).toString('base64').toLowerCase())
  }
}

