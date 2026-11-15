// SPDX-License-Identifier: CPAL-1.0
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

const INVALID_PATH = 'invalid workspace path'

function failPath(): never { throw new Error(INVALID_PATH) }

function isReservedName(segment: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(segment)
}

export function assertSafeRelativePath(input: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof input !== 'string') return failPath()
  if (input.length === 0) {
    if (options.allowEmpty) return ''
    return failPath()
  }
  if (/[\u0000-\u001f\u007f]/.test(input) || input.includes(':')) return failPath()
  if (input.startsWith('/') || input.startsWith('\\') || /^[a-z]:/i.test(input) || isAbsolute(input) || win32.isAbsolute(input)) return failPath()

  const segments = input.split(/[\\/]/)
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || /[. ]$/.test(segment) || isReservedName(segment))) return failPath()
  return join(...segments)
}

/**
 * R2-REL-04：Windows 上路径接近 260 字符时，Node 的 JS 版 fs.realpathSync 会抛 EISDIR（lstat 'D:'）；
 * native 版（直接走系统调用）没有这个毛病。JS 版失败就回退 native；两边都失败，抛 native 的错（ENOENT / ENOTDIR 由调用方往上找父目录）。
 */
function realpath(p: string): string {
  try { return realpathSync(p) } catch { return realpathSync.native(p) }
}

function realPathWithMissingTail(target: string): string {
  let current = resolve(target)
  const tail: string[] = []
  while (true) {
    try {
      lstatSync(current)
      const realCurrent = realpath(current)
      return resolve(realCurrent, ...tail.reverse())
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      tail.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      current = parent
    }
  }
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function resolveConfinedPath(
  root: string,
  input: string,
  options: { anchorRoot?: string; mustExist?: boolean; allowRoot?: boolean } = {},
): string {
  const safeInput = assertSafeRelativePath(input, { allowEmpty: options.allowRoot === true })
  const resolvedRoot = resolve(root)
  const rootReal = realPathWithMissingTail(resolvedRoot)
  if (options.anchorRoot !== undefined) {
    const anchorReal = realPathWithMissingTail(resolve(options.anchorRoot))
    if (!isContained(anchorReal, rootReal)) return failPath()
  }

  const target = safeInput === '' ? resolvedRoot : resolve(resolvedRoot, safeInput)
  const rel = relative(resolvedRoot, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return failPath()
  if (rel === '' && options.allowRoot !== true) return failPath()

  const targetReal = realPathWithMissingTail(target)
  if (!isContained(rootReal, targetReal)) return failPath()
  if (options.mustExist) {
    try { lstatSync(target) } catch { return failPath() }
  }
  return target
}
