// SPDX-License-Identifier: CPAL-1.0
// 清单：给 BacktestSpec.data.files[] 用的 {path, sha256, format, kind}（path 绝对化，sha256 与引擎校验口径一致）。
import { readFileSync } from 'node:fs'
import { formatFromPath, sha256Digest } from './inspect'
import { resolveDataPath } from './root'
import type { ManifestEntry, ManifestInput, PathOptions } from './types'

/** 文件清单；kind 缺省 'candles'，format 只看扩展名，sha256 为 `sha256:<hex>`。顺序与入参一致。 */
export function manifestFor(files: readonly ManifestInput[], opts: PathOptions = {}): ManifestEntry[] {
  return files.map((f) => {
    const abs = resolveDataPath(f.path, opts.root, 'data file')
    const buf = readFileSync(abs)
    return {
      path: abs,
      kind: f.kind ?? 'candles',
      format: formatFromPath(abs),
      sha256: sha256Digest(buf),
      bytes: buf.length,
    }
  })
}
