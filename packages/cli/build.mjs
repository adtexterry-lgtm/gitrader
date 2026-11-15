// SPDX-License-Identifier: CPAL-1.0
// 发布包构建：把 CLI + 内核 + MCP 服务器 + 参考引擎 + 工作台静态文件做成一个自包含的 npm 包（包名 gitrader）。
//   node build.mjs            在 packages/cli 下（npm pack / publish 前会自动跑：prepack）
// 产物（全在 dist/ 下，包里 files 只放这些 + README / LICENSE / NOTICE / THIRD-PARTY-NOTICES.md）：
//   dist/bin.js              gitrader 命令行 + 内核（单文件，依赖全部内联）
//   dist/gitrader-mcp.js     MCP 服务器（gitrader-mcp，单文件）；`gitrader mcp snippet` 生成的配置指向它
//   dist/engine-core.mjs     随包参考引擎 gitrader-core（内核按 GITRADER_ENGINE_CORE_BUNDLE > 同目录 engine-core.mjs 找到它）
//   dist/python-engine/      Python GEP builtin 的标准库源码（内核按同目录 python-engine/engine/main.py 找到它）
//   dist/workbench/          工作台静态文件（内核按同目录 workbench/ 找到它）
// 默认用户机上没有 Git / Java / pnpm，只有 Node：安装包里不含任何需要再编译的东西。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeNotices } from '../../scripts/gen-notices.mjs'
import { buildEngineWithMeta } from '../engine-core/build.mjs'
import { copyPythonEngine } from './build-python.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const dist = join(here, 'dist')
const BANNER = "import { createRequire as __gtCreateRequire } from 'node:module'; const require = __gtCreateRequire(import.meta.url);"

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
const groups = {}

async function bundle(name, entry, outfile, banner) {
  const r = await build({
    absWorkingDir: here, entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: banner }, legalComments: 'external', metafile: true, logLevel: 'warning',
    external: ['bufferutil', 'utf-8-validate'], // ws 的可选原生加速模块：没装就走纯 JS
  })
  groups[name] = Object.keys(r.metafile.inputs).map((f) => resolve(here, f))
}

// 1) CLI + 内核（bin.ts 自带 #!/usr/bin/env node，esbuild 会把它留在第一行）
await bundle('cli', 'src/bin.ts', join(dist, 'bin.js'), BANNER)
// 2) MCP 服务器
await bundle('mcp', '../mcp/src/bin.ts', join(dist, 'gitrader-mcp.js'), `#!/usr/bin/env node\n${BANNER}`)
// 3) 参考引擎（带机器人模板装配层）
await bundle('launcher', 'src/engine-core-launcher.ts', join(dist, 'engine-core.mjs'), `#!/usr/bin/env node\n${BANNER}`)
groups.launcher = groups.launcher || [] // bundle 已经填充了 groups.launcher
// 4) Python GEP builtin：只复制随包入口，不复制解释器或用户策略。
groups.python = copyPythonEngine(join(root, 'packages', 'engine-python', 'engine'), dist)
// 5) 工作台（它的构建脚本支持 GITRADER_UI_OUT；在 packages/workbench 下跑，metafile 的相对路径以它为基准）
const wbDir = join(root, 'packages', 'workbench')
const wbOut = join(dist, 'workbench')
const wb = spawnSync(process.execPath, [join(wbDir, 'build.mjs')], { cwd: wbDir, env: { ...process.env, GITRADER_UI_OUT: wbOut }, encoding: 'utf8' })
if (wb.status !== 0) { process.stderr.write(wb.stdout + wb.stderr); throw new Error('workbench build failed') }
const wbMeta = JSON.parse(readFileSync(join(wbOut, 'meta.json'), 'utf8'))
groups.workbench = Object.keys(wbMeta.inputs).map((f) => resolve(wbDir, f))
rmSync(join(wbOut, 'meta.json'))

// 6) 随包文件：LICENSE / NOTICE / 第三方声明
copyFileSync(join(root, 'LICENSE'), join(here, 'LICENSE'))
copyFileSync(join(root, 'NOTICE'), join(here, 'NOTICE'))
const productNames = { cli: 'dist/bin.js（命令行 + 内核）', mcp: 'dist/gitrader-mcp.js', engine: 'dist/engine-core.mjs', python: 'dist/python-engine/engine/*.py', workbench: 'dist/workbench/app.js' }
const pkgs = writeNotices(join(here, 'THIRD-PARTY-NOTICES.md'), groups, { productNames })
copyFileSync(join(here, 'THIRD-PARTY-NOTICES.md'), join(root, 'THIRD-PARTY-NOTICES.md'))

// 7) 上手技能：随包带上，`gitrader skill install` 从 dist/skills 读取；源文件不在时只警告，不阻断发布。
const skillSource = join(root, 'integrations', 'claude-code', 'SKILL.md')
if (existsSync(skillSource)) {
  const skillOut = join(dist, 'skills', 'gitrader-onboarding')
  mkdirSync(skillOut, { recursive: true })
  copyFileSync(skillSource, join(skillOut, 'SKILL.md'))
} else {
  process.stderr.write(`warning: ${skillSource} not found; dist/skills/gitrader-onboarding/SKILL.md was not copied\n`)
}

// 8) 随包通知插件（默认不启用；`gitrader plugins install <名>` 拷到用户目录并现场钉版本）
const pluginsOut = join(dist, 'plugins-bundled')
for (const d of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!d.isDirectory() || !d.name.startsWith('plugin-notify-')) continue
  const src = join(root, 'packages', d.name)
  const dest = join(pluginsOut, d.name.slice('plugin-'.length))
  mkdirSync(dest, { recursive: true })
  // UX-27：fake-*.mjs 是测试桩，不随包；但别的 .mjs 还静态 import 它时必须带上（否则插件加载不起来），改成动态 import 后这里自动不再带。
  const mjs = readdirSync(src).filter((n) => n.endsWith('.mjs'))
  const stubInUse = (n) => mjs.some((m) => m !== n && new RegExp(`from\s+['"]\./${n.replace(/\./g, '\.')}['"]`).test(readFileSync(join(src, m), 'utf8')))
  for (const f of readdirSync(src, { withFileTypes: true })) {
    if (!f.isFile()) continue
    if (f.name.startsWith('fake-') && !stubInUse(f.name)) continue
    const keep = ['gitrader-plugin.json', 'LICENSE', 'README.md'].includes(f.name) || (f.name.endsWith('.mjs') && f.name !== 'run-conformance.mjs')
    if (keep) copyFileSync(join(src, f.name), join(dest, f.name))
  }
}

// 8b) 随包插件内容哈希清单（R2-REL-10，不引入签名私钥）：每个随包插件目录一条 {dir, id, version, pin, manifest}，
//     pin 就是 `gitrader plugins check <dir> --json` 的 pin。内核只信产品目录（bin.js 同目录）里的这份清单。
//     哈希算法直接用内核的实现（打成临时模块导入），不在这里另写一份。
{
  const tmp = mkdtempSync(join(tmpdir(), 'gitrader-bundled-hashes-'))
  try {
    const genFile = join(tmp, 'gen.mjs')
    await build({
      absWorkingDir: here, stdin: { contents: "export { bundledHashManifest } from '@gitrader/kernel'", resolveDir: here, loader: 'ts' },
      outfile: genFile, bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: BANNER }, logLevel: 'warning',
      external: ['bufferutil', 'utf-8-validate'],
    })
    const { bundledHashManifest } = await import(pathToFileURL(genFile).href)
    const manifest = bundledHashManifest(pluginsOut)
    if (!Array.isArray(manifest.plugins) || manifest.plugins.length === 0) throw new Error('no bundled plugin found for BUNDLED-HASHES.json')
    writeFileSync(join(pluginsOut, 'BUNDLED-HASHES.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

// 9) 示例策略 + 空白模板（教学示例，无业绩含义；不默认加载，`gitrader examples copy <名>` 拷进策略文件夹）
const exOut = join(dist, 'examples', 'strategies')
mkdirSync(exOut, { recursive: true })
const exSrc = join(root, 'packages', 'engine-core', 'examples', 'strategies')
for (const f of readdirSync(exSrc)) if (f.endsWith('.ts')) copyFileSync(join(exSrc, f), join(exOut, f))
copyFileSync(join(root, 'packages', 'engine-core', 'strategy-template', 'strategy.ts'), join(dist, 'examples', 'strategy-template.ts'))
const EXAMPLES_README = `这是教学示例，无业绩含义。

拷贝示例策略：gitrader examples copy grid
或手工拷到 ~/.gitrader/engines/gitrader-core/strategies/

拷完改文件里的 id 与 name。strategy-template.ts 是只有接口的空白模板。
`
writeFileSync(join(dist, 'examples', 'README.txt'), EXAMPLES_README, 'utf8')

const size = (d) => readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(join(d, e.name)) : readFileSync(join(d, e.name)).length), 0)
process.stderr.write(`gitrader package built: dist ${(size(dist) / 1024 / 1024).toFixed(2)} MB, ${pkgs.length} third-party packages in THIRD-PARTY-NOTICES.md
`)
if (!existsSync(join(dist, 'workbench', 'index.html'))) throw new Error('workbench/index.html missing')
