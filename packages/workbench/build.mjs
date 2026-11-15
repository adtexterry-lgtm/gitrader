// SPDX-License-Identifier: CPAL-1.0
// 工作台壳构建：src/app.jsx → dist/{index.html, app.js, app.css, block-boot.js, fonts/}（单文件，无 CDN，无外链）。
//   node build.mjs              （在 packages/workbench 下，或 npm run build -w @gitrader/workbench）
// 环境变量 GITRADER_UI_OUT 改输出目录（验收脚本用，避免覆盖正在被内核服务的 dist）。
// r2（PLAN 8.3）：Tailwind v4 只在构建期——CLI 先把 src/ui/tw.css 编成输出目录里的临时 .tw.css，经 virtual:tw 第一个进包，构建完删掉；
// react / react-dom 别名到 preact/compat（Radix 三件用）；woff2 按原字节拷进 fonts/；壳 / 块的旧 CSS 包进 @layer gr-legacy。
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = process.env.GITRADER_UI_OUT ? resolve(process.env.GITRADER_UI_OUT) : resolve(here, 'dist')

// 字标原件门禁：顶栏 / 关于页用的是仓库 assets/brand 里 维护者 定稿的原件（sha256 必须对得上 SHA256SUMS），不许重画、不许改字节。
const brandDir = resolve(here, '../../assets/brand')
const wantWm = /^([0-9a-f]{64})\s+gitrader-wordmark\.svg\s*$/im.exec(await readFile(resolve(brandDir, 'SHA256SUMS'), 'utf8'))?.[1]?.toLowerCase()
const gotWm = createHash('sha256').update(await readFile(resolve(brandDir, 'gitrader-wordmark.svg'))).digest('hex')
if (!wantWm || wantWm !== gotWm) throw new Error(`字标原件校验失败：gitrader-wordmark.svg 的 sha256 ${gotWm} 与 SHA256SUMS（${wantWm ?? '缺'}）不符`)

// 字体原字节门禁：Geist / Geist Mono 可变字重拉丁子集（OFL-1.1），sha256 必须对得上 src/ui/fonts/SHA256SUMS（构建后再核一次产物里的拷贝）
const sha256 = async (p) => createHash('sha256').update(await readFile(p)).digest('hex')
const fontDir = resolve(here, 'src/ui/fonts')
const fontSums = [...(await readFile(resolve(fontDir, 'SHA256SUMS'), 'utf8')).matchAll(/^([0-9a-f]{64})\s+\*?(\S+\.woff2)\s*$/gim)].map((m) => [m[2], m[1].toLowerCase()])
if (fontSums.length < 2) throw new Error('字体校验失败：src/ui/fonts/SHA256SUMS 少于两条 woff2')
for (const [name, want] of fontSums) { const got = await sha256(resolve(fontDir, name)); if (got !== want) throw new Error(`字体校验失败：${name} 的 sha256 ${got} 与 SHA256SUMS（${want}）不符`) }

// 源码门禁（PLAN 4.11）：颜色字面量只在 theme.css 的 TOKENS 块（其余 CSS 一个都不许）；类名里不许出现 Tailwind 默认色板（bg-blue-500 之类）
// 与任意值颜色 / 字号（-[#…]、-[rgb…]、text-[12px]）——默认色板在 tw.css 里已清空，这里让违规直接构建失败。
async function filesUnder(dir) {
  const acc = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name)
    if (e.isDirectory()) acc.push(...(await filesUnder(p)))
    else acc.push(p)
  }
  return acc
}
const srcFiles = (await Promise.all([resolve(here, 'src'), resolve(here, '../blocks-default/src')].map(filesUnder))).flat()
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/
const PALETTE = /\b[a-z][a-z-]*-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/
const ARBITRARY = /-\[(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|color-mix\()|\btext-\[\d/
const themeCss = resolve(here, 'src/ui/theme.css')
// 源码层禁词 / emoji（H1）：esbuild 默认 charset=ascii，产物里的中文与 emoji 都写成 \u 转义，产物扫描对它们是空转，所以在源码层扫（含注释）。
// 范围 = 壳 + 一方块的 src；@gitrader/protocol 的承诺用语检测正则（故意写成转义）不在这两个目录里，不用白名单。产物扫描（下方）保留。
const BANNED_SRC = /保守|激进|稳赚|跑赢|稳定盈利|\p{Emoji_Presentation}|\u{FE0F}/u
for (const f of srcFiles) {
  if (/\.(jsx|tsx|js|ts|css|html)$/.test(f)) {
    const m = BANNED_SRC.exec(await readFile(f, 'utf8'))
    if (m) throw new Error(`${f} 含禁词或 emoji「${m[0]}」：产品文案零承诺语言、不用 emoji（AGENTS.md 红线 5）`)
  }
  if (f.endsWith('.css')) {
    let css = await readFile(f, 'utf8')
    if (f === themeCss) css = css.replace(/\/\* ===== BEGIN TOKENS ===== \*\/[\s\S]*?\/\* ===== END TOKENS ===== \*\//, '')
    if (f === themeCss) css = css.replace(/\/\* ===== BEGIN TOKENS v6 ===== \*\/[\s\S]*?\/\* ===== END TOKENS v6 ===== \*\//, '')
    const m = LITERAL.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
    if (m) throw new Error(`${f} 含颜色字面量「${m[0]}」：颜色只许写在 theme.css 的 TOKENS 块，这里改用 var(--gr-*)`)
  } else if (/\.(jsx|tsx|js|ts)$/.test(f)) {
    const code = await readFile(f, 'utf8')
    const m = PALETTE.exec(code) || ARBITRARY.exec(code)
    if (m) throw new Error(`${f} 含「${m[0]}」：不许用 Tailwind 默认色板或任意值颜色 / 字号，用令牌映射的名字（text-text-3、bg-ink-2、text-xs…）`)
  }
}

(await import('./design/source-scan.mjs')).assertClean(resolve(here, 'src'), resolve(here, '../blocks-default/src')) // r4 源码级扫描（施工单 7.2-3）：全圆 / 直角 / 解释性小标题 / 禁词，命中即构建失败

// .svg 当字符串打进包。品牌原件（assets/brand）原字节不动；其余图标里的白色 fill 换成 currentColor 跟随主题色（原件文件不改）。
const svgText = {
  name: 'svg-text',
  setup(b) {
    b.onLoad({ filter: /\.svg$/ }, async (a) => {
      const raw = await readFile(a.path, 'utf8')
      const text = /[\\/]assets[\\/]brand[\\/]/.test(a.path) ? raw : raw.replace(/fill="#FFFFFF"/gi, 'fill="currentColor"').trim()
      return { contents: `export default ${JSON.stringify(text)}`, loader: 'js' }
    })
  },
}

// Tailwind 生成的 CSS：virtual:tw → 输出目录里的临时文件（不写进 src/、不碰 .gitignore），app.jsx 第一行导入，保证 @layer 顺序排在所有 CSS 最前
const twOut = resolve(out, '.tw.css')
const virtualTw = {
  name: 'virtual-tw',
  setup(b) {
    b.onResolve({ filter: /^virtual:tw$/ }, () => ({ path: twOut, namespace: 'gr-tw' }))
    // 以 src/ui 为解析目录：tw.css 里 @font-face 的 ./fonts/*.woff2 按源文件位置找（文件 loader 原字节拷进 dist/fonts/）
    b.onLoad({ filter: /.*/, namespace: 'gr-tw' }, async () => ({ contents: await readFile(twOut, 'utf8'), loader: 'css', resolveDir: resolve(here, 'src/ui') }))
  },
}
// 旧 CSS 进层：壳 / 块的类名样式整体包进 @layer gr-legacy（Tailwind 工具类在 utilities 层，才压得过它们）；文件里已经自己写了 @layer gr-legacy 的不动
const legacyLayer = {
  name: 'legacy-layer',
  setup(b) {
    b.onLoad({ filter: /[\\/](shell|blocks)\.css$/ }, async (a) => {
      const raw = await readFile(a.path, 'utf8')
      return { contents: /@layer\s+gr-legacy\b/.test(raw) ? raw : `@layer gr-legacy {\n${raw}\n}\n`, loader: 'css' }
    })
  },
}
const twCli = [resolve(here, '../../node_modules/@tailwindcss/cli/dist/index.mjs'), resolve(here, 'node_modules/@tailwindcss/cli/dist/index.mjs')].find((p) => existsSync(p))
if (!twCli) throw new Error('找不到 @tailwindcss/cli（packages/workbench 的 devDependencies）：先在仓库根目录 npm install')

await mkdir(out, { recursive: true })
const t0 = Date.now()
let result
try {
  try {
    execFileSync(process.execPath, [twCli, '-i', resolve(here, 'src/ui/tw.css'), '-o', twOut, '--minify'], { cwd: here, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) { throw new Error('Tailwind 生成 CSS 失败：' + String(e.stderr || e.message).slice(0, 600)) }
  result = await build({
    entryPoints: [resolve(here, 'src/app.jsx')],
    outfile: resolve(out, 'app.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.js': 'jsx', '.woff2': 'file' },
    assetNames: 'fonts/[name]',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' }, // Radix 的 react / react-dom / react/jsx-runtime 全落到 preact/compat，产物里没有真 React
    plugins: [virtualTw, legacyLayer, svgText],
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    legalComments: 'linked', // app.js.LEGAL.txt / app.css.LEGAL.txt：Preact、Radix、Tailwind 的版权与许可证注释不剥掉
    logLevel: 'info',
    metafile: true,
  })
} finally {
  await rm(twOut, { force: true })
}

// 产物门禁：没有真 React（别名必须生效）；字体拷贝与原件逐字节一致
const reactIn = Object.keys(result.metafile.inputs).filter((p) => /node_modules[\\/](react|react-dom)[\\/]/.test(p))
if (reactIn.length) throw new Error(`app.js 打进了真 React（alias 没生效）：${reactIn.slice(0, 3).join(' ')}`)
for (const [name, want] of fontSums) {
  const p = resolve(out, 'fonts', name)
  if (!existsSync(p) || (await sha256(p)) !== want) throw new Error(`产物字体与原件不一致：fonts/${name}`)
}

// 产物门禁：不许外链；不许出现禁词（含收益承诺用语）；不许出现真 React 的内部符号
const allowed = (u) => /w3\.org|reactjs\.org|preactjs\.com|github\.com|developer\.mozilla|react\.dev|tradingview\.com/.test(u)
for (const f of ['app.js', 'app.css']) {
  const text = await readFile(resolve(out, f), 'utf8')
  const bad = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => !allowed(u))
  if (bad.length) throw new Error(`${f} 含外链：${bad.slice(0, 5).join(' ')}`)
  for (const w of [/comfy/i, /walletconnect/i, /保守/, /激进/, /稳赚/, /跑赢/, /稳定盈利/, /greensock/i]) if (w.test(text)) throw new Error(`${f} 含禁词 ${w}`)
  if (/__CLIENT_INTERNALS_DO_NOT_USE|react-dom\.production/.test(text)) throw new Error(`${f} 含真 React 的内部符号`)
}

// favicon：字标里的 G（原件），内联成 data URI
const icon = async (name, size) => `<link rel="icon" type="image/svg+xml" sizes="${size}x${size}" href="data:image/svg+xml,${encodeURIComponent((await readFile(resolve(here, 'src/ui/brand', name), 'utf8')).trim())}">`
const html = (await readFile(resolve(here, 'src/index.html'), 'utf8')).replace('<!--FAVICON-->', (await icon('g-glyph-32.svg', 32)) + '\n' + (await icon('g-glyph-16.svg', 16)))
await writeFile(resolve(out, 'index.html'), html)
await copyFile(resolve(here, 'src/block-boot.js'), resolve(out, 'block-boot.js'))
await writeFile(resolve(out, 'meta.json'), JSON.stringify(result.metafile))
console.log(`gitrader workbench built → ${out} (${Date.now() - t0} ms)`)
