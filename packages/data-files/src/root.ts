// SPDX-License-Identifier: CPAL-1.0
// 路径约束（L5-06）是可选的：调用方给了 `root` 就约束本包的读写，没给就不约束（与批 10 之前一致）。
// 给了 root 时上两道闸门：① 词法解析后必须仍在 root 内（挡住 `../` 与绝对路径逃逸）；② 对最长的已存在
// 祖先做 realpath 复查（挡住符号链接把落点带出 root）。扩展名白名单仍然在，但只作第二道。
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** target 是否在 root 内（root 自身算在内）；用 relative 以便 Windows 下大小写不敏感。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 把 `target` 解析成绝对路径并确认它落在 `root` 里；越界抛错（消息只含调用方给的路径，不含读到的内容）。
 * `label` 只用于错误消息（`data file` / `output file`）。
 */
export function resolveWithin(root: string, target: string, label = 'path'): string {
  const rootAbs = resolve(root)
  let realRoot: string
  try {
    realRoot = realpathSync(rootAbs)
  } catch {
    throw new Error(`data root does not exist: ${root}`)
  }
  const abs = resolve(rootAbs, target)
  if (!isInside(rootAbs, abs)) throw new Error(`${label} escapes the data root: ${target}`)

  // 符号链接复查：从 target 往上找第一个已存在的祖先做 realpath（输出文件可能还不存在）。
  let probe = abs
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  let realProbe: string
  try {
    realProbe = realpathSync(probe)
  } catch {
    throw new Error(`${label} is not accessible: ${target}`)
  }
  if (!isInside(realRoot, realProbe)) throw new Error(`${label} escapes the data root: ${target}`)
  return abs
}

/**
 * 解析数据路径：给了 `root` 就强制落在它里面（见 {@link resolveWithin}）；没给 `root` 时不做约束，
 * 只把 `target` 解析成绝对路径。任何把本包接到 Agent / 插件 / 远程调用面的代码都必须显式传 `root`。
 */
export function resolveDataPath(target: string, root?: string, label = 'path'): string {
  if (root === undefined) return resolve(target)
  return resolveWithin(root, target, label)
}
