// SPDX-License-Identifier: CPAL-1.0
// 生成 packages/mcp/BUDGET.md：用 esbuild 把 src/budget.ts 打成临时 ESM 再运行（不依赖 TS 运行时）。
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-budget-'))
try {
  const out = join(tmp, 'budget.mjs')
  await build({ absWorkingDir: pkg, entryPoints: ['src/budget.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error' })
  const { computeBudget, renderBudgetMd } = await import(pathToFileURL(out).href)
  const r = computeBudget()
  writeFileSync(join(pkg, 'BUDGET.md'), renderBudgetMd(r), 'utf8')
  console.log(`BUDGET.md written: ${r.toolCount} tools, ${r.violations.length} violation(s)`)
  if (r.violations.length) { for (const v of r.violations) console.error(`  - ${v}`); process.exitCode = 1 }
} finally { rmSync(tmp, { recursive: true, force: true }) }
