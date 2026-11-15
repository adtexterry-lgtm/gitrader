// SPDX-License-Identifier: CPAL-1.0
// 工作区 TS → 可 import 的 ESM：照 bench/engine/run.mjs 的做法，用仓库里已有的 esbuild 打成一个
// 临时文件再 import。这样本目录全是 .mjs，node --test 不需要 TS 运行时，也不新增依赖。
//
// 不联网、不写仓库内文件（临时目录在 os.tmpdir()），也不需要构建整个工作区。

import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cache = new Map()
let tmpRoot = null

/** 仓库根（tools/bench/lib → ../../..）。 */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

function scratchDir() {
  if (tmpRoot === null) tmpRoot = mkdtempSync(join(tmpdir(), 'gitrader-bench-'))
  return tmpRoot
}

/**
 * 把某个 TS 入口打成 ESM 并 import（结果按 entry 缓存，同一进程只打一次）。
 * @param {string} entry TS 入口绝对路径
 * @param {{name?: string}} [o]
 */
export async function loadTsModule(entry, o = {}) {
  const key = resolve(entry)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const name = o.name ?? key.split(/[\\/]/).slice(-2).join('-').replace(/\.ts$/, '')
  const outfile = join(scratchDir(), `${name}.mjs`)
  try {
    await build({
      entryPoints: [key],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile,
      external: ['bufferutil', 'utf-8-validate'],
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'warning',
    })
  } catch (err) {
    throw new Error(`bench: 打包 ${key} 失败（需要仓库内已有的 esbuild，不新增依赖）：${err?.message ?? err}`)
  }
  const mod = await import(pathToFileURL(outfile).href)
  cache.set(key, mod)
  return mod
}

/**
 * 一次取齐三个被测对象：
 *  · core   = @gitrader/engine-core（runBacktest / synthCandles / loadStrategyFile）
 *  · ta     = engine-core 的指标库入口（不在包入口里导出，单独打包）
 *  · report = @gitrader/report（renderBoth / renderMarkdown / renderHtml）
 */
export async function loadBenchDeps(root = repoRoot()) {
  const [core, ta, report] = await Promise.all([
    loadTsModule(join(root, 'packages', 'engine-core', 'src', 'index.ts'), { name: 'engine-core' }),
    loadTsModule(join(root, 'packages', 'engine-core', 'src', 'strategy', 'ta', 'index.ts'), { name: 'engine-core-ta' }),
    loadTsModule(join(root, 'packages', 'report', 'src', 'index.ts'), { name: 'report' }),
  ])
  return { core, ta, report }
}

/** 清掉临时目录里的打包产物（供测试收尾；不删就等系统清理）。 */
export function tempDir() {
  return tmpRoot
}
