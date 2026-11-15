// SPDX-License-Identifier: CPAL-1.0
// 用法：node bench/connector/run.mjs [--out bench/connector/result.json]
// 用 esbuild 把 entry.ts 打包到临时目录再运行（源码是 TypeScript、导入不带扩展名，Node 不能直接跑）。输出 JSON。
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outIdx = process.argv.indexOf('--out')
const outFile = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : null
const dir = mkdtempSync(join(tmpdir(), 'gitrader-bench-'))
try {
  const bundle = join(dir, 'entry.mjs')
  await build({ entryPoints: [join(here, 'entry.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error', external: ['node:*'] })
  const { runBench } = await import(pathToFileURL(bundle).href)
  const result = { generatedAt: new Date().toISOString(), ...(await runBench(join(here, '..', '..', 'fixtures', 'hl'))) }
  const text = JSON.stringify(result, null, 2)
  if (outFile) writeFileSync(outFile, text + '\n')
  console.log(text)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
