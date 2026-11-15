// SPDX-License-Identifier: CPAL-1.0
// 防漂移对照：本目录的复制件（alpha158 / factor-eval）与 engine-core 的 TS 源逐点比对。
// TS 源用仓库里已有的 esbuild 打成 ESM 临时文件再 import；临时目录在 os.tmpdir()，用例结束即删。
// 不 import tools/bench（目录间不互相依赖），也不写仓库内文件、不联网。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { alpha158Catalog, computeAlpha158 } from '../../packages/cli/src/research/alpha158.mjs'
import { forwardReturns, icSummary, quantileReturns, rankIc, rollingIc } from '../../packages/cli/src/research/factor-eval.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** esbuild 的 import 说明符：统一用正斜杠，Windows 盘符路径也能解析。 */
function specifier(relPath) {
  return JSON.stringify(join(REPO_ROOT, relPath).replace(/\\/g, '/'))
}

/** 把 TS 源打成 ESM 并 import；返回 { mod, cleanup }。 */
async function loadEngineCore() {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-research-parity-'))
  const entry = join(dir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * from ${specifier('packages/engine-core/src/strategy/factor-eval.ts')}`,
      `export * from ${specifier('packages/engine-core/src/strategy/alpha158.ts')}`,
      `export { synthCandles } from ${specifier('packages/engine-core/src/index.ts')}`,
    ].join('\n'),
    'utf8',
  )
  const outfile = join(dir, 'engine-core.mjs')
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
    return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

test('与 engine-core TS 源逐点对照：157 因子 / IC / 滚动 IR / 分组收益', async () => {
  const { mod: ts, cleanup } = await loadEngineCore()
  try {
    assert.deepStrictEqual(alpha158Catalog(), ts.alpha158Catalog())

    const candles = ts.synthCandles({ n: 800, seed: 3, intervalMs: 3_600_000 })
    assert.equal(candles.length, 800)

    const mine = computeAlpha158(candles)
    const theirs = ts.computeAlpha158(candles)
    const names = Object.keys(theirs)
    assert.deepStrictEqual(Object.keys(mine), names)
    assert.equal(names.length, 157)
    for (const name of names) {
      assert.deepStrictEqual(mine[name], theirs[name], `因子 ${name} 序列不一致`)
    }

    for (const horizon of [1, 5]) {
      const fwdMine = forwardReturns(candles, horizon)
      const fwdTheirs = ts.forwardReturns(candles, horizon)
      assert.deepStrictEqual(fwdMine, fwdTheirs, `horizon=${horizon} 前向收益不一致`)
      for (const name of names) {
        const a = mine[name]
        const b = theirs[name]
        assert.deepStrictEqual(rankIc(a, fwdMine), ts.rankIc(b, fwdTheirs), `horizon=${horizon} ${name} rankIc 不一致`)
        const rollingMine = rollingIc(a, fwdMine, 60)
        const rollingTheirs = ts.rollingIc(b, fwdTheirs, 60)
        assert.deepStrictEqual(rollingMine, rollingTheirs, `horizon=${horizon} ${name} rollingIc 不一致`)
        assert.deepStrictEqual(icSummary(rollingMine), ts.icSummary(rollingTheirs), `horizon=${horizon} ${name} icSummary 不一致`)
        assert.deepStrictEqual(quantileReturns(a, fwdMine, 5), ts.quantileReturns(b, fwdTheirs, 5), `horizon=${horizon} ${name} 分组收益不一致`)
      }
    }
  } finally {
    cleanup()
  }
})
