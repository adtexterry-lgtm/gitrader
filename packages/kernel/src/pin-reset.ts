// SPDX-License-Identifier: CPAL-1.0
// 忘了 PIN 的重置（ADR-4）：备份并停用钥匙库 + 吊销全部 AI 钥匙，保留账本、历史记录与安装签名身份。
// 只移动 keys/pin.json、keys/keystore.json 与 keys/device.key.json（不删除任何文件）；keys/install-key.json 原地不动。
// 设备密钥一起移走：B3 把「PIN 文件没了、钥匙库 / 设备密钥还在」判为安全状态损坏（防删 pin.json 绕过），三件一起备份
// 才是干净的「未设 PIN」状态；设备密钥只参与 PIN 派生，旧三件放在同一个备份目录里仍可整体恢复。
// 必须在服务未运行时做：函数自己再查一次 service.json 指向的 pid。
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homePaths } from './config'
import { Kernel } from './kernel'
import { makeProblem } from './proto'
import type { Principal } from './auth'
import { KernelError } from './util/errors'
import { mkOrigin } from './util/origin'
import { systemClock } from './util/clock'
import type { Clock } from './util/clock'

export interface PinResetResult { backupDir: string; revokedKeys: number; movedFiles: string[] }

const SERVICE_RUNNING = '服务还在运行。先运行 gitrader stop 停掉它，再重置 PIN。'

/** service.json 里的 pid 还活着就拒绝：重置过程中另一个进程可能正在写钥匙库。 */
function assertServiceStopped(home: string): void {
  const path = homePaths(home).service
  if (!existsSync(path)) return
  let pid: unknown
  try { pid = (JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid } catch { return }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
  let alive = false
  try { process.kill(pid, 0); alive = true } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM' }
  if (alive) throw new KernelError(makeProblem('INVALID_PARAMS', SERVICE_RUNNING))
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** 本地时间 yyyyMMdd-HHmmss。 */
function stamp(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** `<home>/keys.bak-<stamp>`；同一秒内重复重置加 -2、-3 … */
function nextBackupDir(home: string, now: number): string {
  const base = join(home, `keys.bak-${stamp(now)}`)
  if (!existsSync(base)) return base
  for (let i = 2; ; i++) {
    const next = `${base}-${i}`
    if (!existsSync(next)) return next
  }
}

/**
 * 重置用的进程内会话主体：重置后人已经没法给 PIN 证明（pin.json 刚被移走），
 * 而吊销钥匙 / 授权书只需要 'session' 证明。引导令牌 → 会话是 serve 启动时自己也走的本机路径。
 */
function inProcessSession(k: Kernel): Principal {
  const s = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)
  if (!s || s.kind !== 'session') throw new KernelError(makeProblem('AUTH_FAILED', 'cannot open an in-process session for PIN reset'))
  return s
}

/** 记一条 pin.reset（账本只追加；载荷只有备份目录名与吊销数量，没有任何密钥材料）。 */
function appendPinReset(k: Kernel, backupDirName: string, revokedKeys: number): void {
  const origin = mkOrigin('user:usr_local', 'cli:pin.reset', 'cli')
  k.ledger.append({ type: 'annotation', origin, subject: { orgId: 'org_local' }, payload: { action: 'pin.reset', backupDir: backupDirName, revokedKeys }, attestation: 'user-asserted' })
}

/**
 * 重置 PIN：备份并停用钥匙库，吊销全部未吊销的 AI 钥匙，写一条 pin.reset。
 * 之后由调用方走现有的设 PIN 流程（新 PIN 会重新创建 pin.json 与密钥库）。
 */
export async function resetPin(home: string, o: { now?: number; log?: (m: string) => void } = {}): Promise<PinResetResult> {
  assertServiceStopped(home)
  const now = o.now ?? Date.now()
  const backupDir = nextBackupDir(home, now)
  mkdirSync(backupDir, { recursive: true })
  const keysDir = homePaths(home).keys
  const movedFiles: string[] = []
  for (const name of ['pin.json', 'keystore.json', 'device.key.json']) {
    const src = join(keysDir, name)
    if (!existsSync(src)) continue
    renameSync(src, join(backupDir, name))
    movedFiles.push(name)
  }
  o.log?.(`keys archived to ${basename(backupDir)}: ${movedFiles.join(', ') || '(none)'}`)

  const clock: Clock = o.now === undefined ? systemClock : { now: () => now }
  const k = await Kernel.create({ home, clock, timers: false, ...(o.log ? { log: o.log } : {}) })
  let revokedKeys = 0
  try {
    const proof = k.auth.sessionProof(inProcessSession(k), 'cli')
    const origin = mkOrigin('user:usr_local', 'cli:pin.reset', 'cli')
    for (const key of k.agents.listKeys()) {
      if (key.status === 'revoked') continue
      k.agents.revokeKey(key.keyId, proof, origin)
      revokedKeys++
      o.log?.(`revoked agent key ${key.name} (${key.keyId})`)
    }
    appendPinReset(k, basename(backupDir), revokedKeys)
  } finally {
    await k.stop()
  }
  return { backupDir, revokedKeys, movedFiles }
}
