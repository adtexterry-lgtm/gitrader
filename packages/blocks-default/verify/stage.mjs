// SPDX-License-Identifier: CPAL-1.0
// 无头验证的公共件：构建壳（含本包的块）到临时目录 → 起夹具内核（随机端口，绝不连真数据）→ 无头 Edge。
// 只关自己起的浏览器与服务；不弹可见窗口。shots.mjs 与 test/render.browser.test.ts 共用。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const wbDir = resolve(here, '../../workbench')
export const PW = process.env.GITRADER_PLAYWRIGHT ?? 'playwright-core' // 开发机上的 playwright-core：默认按模块名解析（npm i -D playwright-core），GITRADER_PLAYWRIGHT 可指到别处
export const EDGE = process.env.GITRADER_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
export const PIN = '246810'

export async function startStage(scenario = 'normal') {
  const tmp = mkdtempSync(join(tmpdir(), 'gr-g-'))
  const dist = join(tmp, 'dist')
  const b = spawnSync(process.execPath, [join(wbDir, 'build.mjs')], { env: { ...process.env, GITRADER_UI_OUT: dist }, encoding: 'utf8' })
  if (b.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error('壳构建失败：' + (b.stderr || b.stdout).slice(0, 600)) }
  const tdir = join(here, '.tmp')
  mkdirSync(tdir, { recursive: true })
  const out = join(tdir, `stage-entry-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`)
  await build({ entryPoints: [join(here, 'stage-entry.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', external: ['ws'], logLevel: 'silent' })
  const { startStage: start } = await import(pathToFileURL(out).href)
  const { kernel, stage } = await start({ staticDir: dist, workspacesDir: join(tmp, 'workspaces'), scenario })
  return {
    url: `${kernel.url}/?ui=r4`, kernel, stage, dist,
    async close() {
      try { await kernel.close() } catch { /* 已关闭 */ }
      try { rmSync(out, { force: true }) } catch { /* 无 */ }
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 无 */ }
    },
  }
}

export async function launchBrowser() {
  const { chromium } = createRequire(import.meta.url)(PW)
  return chromium.launch({ executablePath: EDGE, headless: true, args: ['--lang=zh-CN'] })
}

// 夹具预览用的脚本包：把 preview-entry.tsx 打成 iife 字符串（含块与组件库，不含壳）。
export async function bundlePreview() {
  const { readFile } = await import('node:fs/promises')
  const svgText = {
    name: 'svg-text',
    setup(b) {
      b.onLoad({ filter: /\.svg$/ }, async (a) => ({ contents: `export default ${JSON.stringify((await readFile(a.path, 'utf8')).replace(/fill="#FFFFFF"/gi, 'fill="currentColor"').trim())}`, loader: 'js' }))
    },
  }
  const r = await build({
    entryPoints: [join(here, 'preview-entry.tsx')], bundle: true, write: false, format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
    loader: { '.js': 'jsx', '.json': 'json' }, plugins: [svgText], logLevel: 'silent', outdir: join(here, '.tmp'),
    // 块用了组件库的 Menu / PopoverPanel（Radix）：和 build.mjs 同一份别名，否则预览包会把真 React 混进 Preact 渲染直接崩
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/compat/jsx-runtime' },
    define: { __GITRADER_VERSION__: '"preview"', 'process.env.NODE_ENV': '"production"' },
  })
  const js = r.outputFiles.find((f) => f.path.endsWith('.js'))
  const css = r.outputFiles.find((f) => f.path.endsWith('.css'))
  return { js: js ? js.text : '', css: css ? css.text : '' }
}
