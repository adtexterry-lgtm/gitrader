// SPDX-License-Identifier: CPAL-1.0
// Local installation signing key for audit checkpoints and authorization documents.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, createHash } from 'node:crypto'
import { makeProblem } from './proto'
import { KernelError } from './util/errors'
import { StateFileReader } from './util/state-file'
import type { StateFileStatus } from './util/state-file'
import { writeSecretFile } from './util/fsperm'

export interface InstallKeyFile { version: 1; keyId: string; publicKey: string; privateKey: string; createdAt: number }
export interface InstallKeyIdentity { keyId: string; publicKey: string; createdAt: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCanonicalBase64 = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length > 0 && decoded.toString('base64') === value
}
const isInstallKeyFile = (value: unknown): value is InstallKeyFile => {
  if (!isRecord(value) || value.version !== 1 || typeof value.keyId !== 'string' || !value.keyId.trim()
    || !isCanonicalBase64(value.publicKey) || !isCanonicalBase64(value.privateKey)
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) return false
  try {
    const pub = createPublicKey({ key: Buffer.from(value.publicKey, 'base64'), format: 'der', type: 'spki' })
    const priv = createPrivateKey({ key: Buffer.from(value.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    const derived = createPublicKey(priv).export({ format: 'der', type: 'spki' })
    return derived.equals(pub.export({ format: 'der', type: 'spki' }))
  } catch { return false }
}

const corruptError = (): KernelError => new KernelError(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart'))

export class InstallKey {
  private constructor(
    readonly keyId: string,
    readonly publicKey: string,
    private readonly priv: ReturnType<typeof createPrivateKey> | null,
    readonly createdAt: number,
    private readonly reader: StateFileReader<InstallKeyFile>,
  ) {}

  static loadOrCreate(path: string, now = Date.now()): InstallKey {
    const reader = new StateFileReader(path, 'install-key', isInstallKeyFile)
    const f = reader.read()
    if (f) return new InstallKey(f.keyId, f.publicKey, createPrivateKey({ key: Buffer.from(f.privateKey, 'base64'), format: 'der', type: 'pkcs8' }), f.createdAt, reader)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const keyId = `install-${createHash('sha256').update(pub).digest('hex').slice(0, 12)}`
    const file: InstallKeyFile = { version: 1, keyId, publicKey: pub, privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), createdAt: now }
    writeSecretFile(path, JSON.stringify(file), { strict: true })
    reader.read()
    return new InstallKey(keyId, pub, privateKey, now, reader)
  }

  static unavailable(path: string, identity: InstallKeyIdentity): InstallKey {
    const reader = new StateFileReader(path, 'install-key', isInstallKeyFile)
    reader.latchCorruption()
    return new InstallKey(identity.keyId, identity.publicKey, null, identity.createdAt, reader)
  }

  private readBoundFile(): InstallKeyFile | null {
    const file = this.reader.read()
    if (file && (file.keyId !== this.keyId || file.publicKey !== this.publicKey)) {
      this.reader.latchCorruption()
      throw corruptError()
    }
    return file
  }

  stateFileStatus(): StateFileStatus {
    try {
      return { kind: 'install-key', state: this.readBoundFile() === null ? 'missing' : 'ok' }
    } catch (error) {
      if (error instanceof KernelError && error.problem.name === 'STATE_FILE_CORRUPT') return { kind: 'install-key', state: 'corrupt' }
      throw error
    }
  }
  isAvailable(): boolean { return this.priv !== null && this.stateFileStatus().state === 'ok' }

  /** Sign and return base64. The state file is checked on every use. */
  sign(data: string | Uint8Array): string {
    const f = this.readBoundFile()
    if (!f || !this.priv) throw corruptError()
    return edSign(null, typeof data === 'string' ? Buffer.from(data) : data, this.priv).toString('base64')
  }

  static verify(publicKeyB64: string, data: string | Uint8Array, sigB64: string): boolean {
    try {
      const pub = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
      return edVerify(null, typeof data === 'string' ? Buffer.from(data) : data, pub, Buffer.from(sigB64, 'base64'))
    } catch { return false }
  }
}
