// SPDX-License-Identifier: Apache-2.0
// 钉版本：插件目录的内容哈希。算法与内核加载插件时校验的完全一致（内核 plugins.ts 的 artifactList / pinOf）：
//   制品清单 = 包内除清单（gitrader-plugin.json）与顶层 node_modules 外每个文件的 {path, sha256}，路径用 / 分隔、按路径排序；
//   清单 source.sha256 = "sha256:" + sha256(JCS(制品清单))。制品清单只有 path / sha256 两个 ASCII 字段，JCS 与 JSON.stringify 的输出相同。
// 单测里会拿内核自己的实现对拍。没有这个仓库时：gitrader plugins pin <插件目录>。
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MANIFEST_FILE = 'gitrader-plugin.json'
const sha = (b) => createHash('sha256').update(b).digest('hex')

export function artifactList(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' && d === dir) continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (!(d === dir && name === MANIFEST_FILE)) out.push({ path: relative(dir, p).split(sep).join('/'), sha256: sha(readFileSync(p)) })
    }
  }
  walk(dir)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export const pinOf = (artifacts) => `sha256:${sha(JSON.stringify(artifacts))}`

/** 算出哈希并写回清单 source.sha256。 */
export function pinPluginDir(dir) {
  const file = join(dir, MANIFEST_FILE)
  const m = JSON.parse(readFileSync(file, 'utf8'))
  const arts = artifactList(dir)
  m.source = { ...m.source, sha256: pinOf(arts) }
  writeFileSync(file, JSON.stringify(m, null, 2) + '\n', 'utf8')
  return { sha256: m.source.sha256, files: arts.length }
}

/** 钉 example/ 下每个带清单的目录；返回 [{ dir, sha256, files }]。 */
export function pinExamples(exampleRoot) {
  return readdirSync(exampleRoot)
    .map((n) => join(exampleRoot, n))
    .filter((d) => statSync(d).isDirectory() && statSync(join(d, MANIFEST_FILE), { throwIfNoEntry: false })?.isFile())
    .map((d) => ({ dir: d, ...pinPluginDir(d) }))
}

// 直接运行：node scripts/pin.mjs → 重新钉 example/ 下所有示例（build.mjs 打包 ema-reading 之后也走这里）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const r of pinExamples(join(dirname(fileURLToPath(import.meta.url)), '../example'))) console.log(`pinned ${r.files} files → ${r.sha256}  ${r.dir}`)
}
