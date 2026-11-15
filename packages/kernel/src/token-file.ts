// SPDX-License-Identifier: CPAL-1.0
// Agent 令牌文件：令牌只落盘、不打印、不写日志。文件名安全化（只留字母数字 . _ - 与中文），同名不覆盖。
// 权限沿用 util/fsperm 的 writeSecretFile（POSIX 0600；Windows 用 icacls 去掉继承，长路径加 long-path 前缀）；收紧失败要告警（looseTokenFiles + onLoose），不静默。
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecretFile } from './util/fsperm'

const TOKEN_DIR = 'agent-tokens'
/** 本进程里权限没收紧成功的令牌文件路径（内核 status.warnings 带出，doctor 可见）。 */
export const looseTokenFiles: string[] = []
const UNSAFE = /[^\p{Script=Han}A-Za-z0-9._-]/gu

const safeName = (keyName: string): string => {
  const s = String(keyName ?? '').replace(UNSAFE, '-')
  return s === '' ? 'agent' : s
}

/** 令牌文件绝对路径：<home>/agent-tokens/<安全化名字>.token；同名已存在时加 -2、-3…（不覆盖旧文件）。 */
export function tokenFilePath(home: string, keyName: string): string {
  const base = safeName(keyName)
  const dir = join(home, TOKEN_DIR)
  let path = join(dir, `${base}.token`)
  let n = 2
  while (existsSync(path)) { path = join(dir, `${base}-${n}.token`); n++ }
  return path
}

/** 写令牌文件（一行令牌 + \n），返回绝对路径。目录不存在就建；权限收紧失败不抛错，但要告诉调用方（onLoose），不许静默。 */
export function writeTokenFile(home: string, keyName: string, token: string, onLoose?: (path: string) => void): string {
  const dir = join(home, TOKEN_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700) } catch { /* 权限收紧失败不抛错 */ }
  }
  const path = tokenFilePath(home, keyName)
  if (!writeSecretFile(path, `${token}\n`)) { looseTokenFiles.push(path); onLoose?.(path) }
  return path
}
