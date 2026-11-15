// SPDX-License-Identifier: CPAL-1.0
// 把本仓的 TS 连接器（以及包的 test/helpers 假服务器）打成 ESM 临时文件再 import。
// 为什么必须打包：五个交易连接器的源码用了 TS 参数属性（`constructor(private readonly d: ...)`），
// Node 22 的 strip-only 类型擦除不支持这种语法，直接 import .ts 会在加载阶段报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
// 做法照 tools/research/test/parity.test.mjs：仓库里已有的 esbuild、打进 os.tmpdir()、进程退出即删，
// 不写仓库内文件、不联网、不新增依赖、不改任何包。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cache = new Map()
const tempDirs = []
let hooked = false

function hookCleanup() {
  if (hooked) return
  hooked = true
  process.on('exit', () => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 退出阶段删不掉就留在临时目录 */
      }
    }
  })
}

/** esbuild 的 import 说明符：统一正斜杠（Windows 盘符路径也能解析）。 */
function specifier(relPath) {
  return JSON.stringify(join(REPO_ROOT, relPath).replace(/\\/g, '/'))
}

/**
 * 按名字打一个包，每个名字一个命名空间导出（`{ connector: {…}, fake: {…} }`）。
 * @param {Record<string,string>} entries  名字 → 相对仓库根的 TS 入口（如 { connector: 'packages/connector-binance-trade/src/index.ts' }）
 * @returns {Promise<Record<string, Record<string, unknown>>>}
 */
export async function loadBundle(entries) {
  const key = JSON.stringify(entries)
  const cached = cache.get(key)
  if (cached) return cached
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-testnet-journey-'))
  tempDirs.push(dir)
  hookCleanup()
  const entry = join(dir, 'entry.ts')
  const lines = Object.entries(entries).map(([name, relPath]) => `export * as ${name} from ${specifier(relPath)}`)
  writeFileSync(entry, `${lines.join('\n')}\n`, 'utf8')
  const outfile = join(dir, 'bundle.mjs')
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile,
      external: ['bufferutil', 'utf-8-validate'],
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'warning',
    })
    const mod = await import(pathToFileURL(outfile).href)
    cache.set(key, mod)
    return mod
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** 连接器入口相对路径（五个包同一形状）。 */
export function connectorEntry(venue) {
  return `packages/connector-${venue}-trade/src/index.ts`
}
