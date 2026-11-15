// SPDX-License-Identifier: CPAL-1.0
// 本机文件权限收紧：POSIX chmod 600；Windows 用 icacls 去掉继承、只留当前用户（所有 Windows 自带，不依赖 PowerShell 7）。
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, toNamespacedPath } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeProblem } from '../proto'
import { KernelError } from './errors'

let cachedWho: string | undefined
/** icacls 的授权对象：优先当前用户的 SID（`*S-1-…`，纯 ASCII）。账户名不可靠：whoami 按控制台代码页输出，
 *  中文计算机名 / 用户名按 utf8 读成乱码，icacls 认不出（1332）；PATH 里的 Git 也会把 whoami 换成只打用户名的版本。
 *  SID 只认 CSV 的最后一列（账户名那列里写什么都不算）。拿不到用户名就返回空串：icacls 对空主体也报成功，却授给 BUILTIN\BUILTIN。 */
export function aclPrincipal(whoamiCsv: string, env: NodeJS.ProcessEnv = process.env): string {
  const sid = /^"[^"]*","(S-1-\d+(?:-\d+)+)"\s*$/m.exec(whoamiCsv)?.[1]
  if (sid) return `*${sid}`
  return env.USERNAME ? `${env.USERDOMAIN ? env.USERDOMAIN + '\\' : ''}${env.USERNAME}` : ''
}
const sys32 = (exe: string) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe)
function who(): string {
  if (cachedWho) return cachedWho
  let csv = ''
  try { csv = execFileSync(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'latin1' }) } catch { /* 退到环境变量里的账户名（Unicode 正确） */ }
  cachedWho = aclPrincipal(csv)
  return cachedWho
}

/** Windows：路径接近 MAX_PATH 时 icacls 报退出码 3；换成 \\?\ 前缀即可（阈值同 db.ts 的 sqlitePath，短路径完全不变）。 */
function aclPath(path: string): string {
  return process.platform === 'win32' && path.length >= 200 ? toNamespacedPath(resolve(path)) : path
}

/** 收紧失败不抛错（返回 false），调用方在状态里如实标注，或用 writeSecretFile 的 strict 模式直接拒写。 */
export function tightenFile(path: string): boolean {
  try {
    if (process.platform === 'win32') {
      const principal = who()
      if (!principal) return false // 不知道授给谁就不收紧：strict 调用方据此拒写，原文件不动
      execFileSync(sys32('icacls.exe'), [aclPath(path), '/inheritance:r', '/grant:r', `${principal}:F`], { windowsHide: true, stdio: 'ignore' })
    } else {
      chmodSync(path, 0o600)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 原子写（临时文件 + rename）并收紧权限，返回是否收紧成功。
 * strict:true（钥匙库 / PIN / 设备钥 / 安装签名钥）：收紧失败就删掉临时文件并抛错，绝不留下别的用户读得到的密钥文件。
 */
export function writeSecretFile(path: string, data: string, opts: { strict?: boolean } = {}): boolean {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
  const ok = tightenFile(tmp)
  if (!ok && opts.strict) {
    try { unlinkSync(tmp) } catch { /* 临时文件已不在 */ }
    // 两种常见原因都如实写出来：路径过长，或所在文件系统不支持权限设置（exFAT / FAT32 的 U 盘、网络盘）。不放宽 strict。
    throw new KernelError(makeProblem('INTERNAL', `cannot restrict permissions on secret file ${path}; refused to write it. Possible causes: (1) the path is too long (${path.length} characters; the Windows limit is about 260); (2) the file system does not support permissions (e.g. an exFAT / FAT32 USB drive or a network drive). Put GITRADER_HOME on a local NTFS disk, in a shorter directory, and retry. 无法把密钥文件的权限收紧到只有当前用户可读，已拒绝写入：${path}。可能原因有两种：(1) 路径过长（${path.length} 个字符，Windows 上限约 260）；(2) 所在文件系统不支持权限设置（如 exFAT / FAT32 的 U 盘、网络盘）。请把 GITRADER_HOME 放在本机 NTFS 盘的较短目录下再试`))
  }
  renameSync(tmp, path)
  return ok
}

export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, path)
}
