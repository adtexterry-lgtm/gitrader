// SPDX-License-Identifier: CPAL-1.0
// 把已构建的产物打成 UNIGIT 商店用的两个 zip，并把真实的 size / sha256 回填进两份配方。
//   node integrations/unigit/pack.mjs [--out <目录>]      默认输出到仓库根的 dist-store/
// 前提：先构建（node scripts/build.mjs cli mcp workbench engine-core，且 packages/cli/dist 里有 bin.js / engine-core.mjs / workbench/）。
// zip 内容（根目录即 {installDir}）：
//   gitrader-app-<版本>.zip  = bin.js、bin.js.LEGAL.txt、engine-core.mjs、workbench/、plugins-bundled/、examples/（取自 packages/cli/dist）
//   gitrader-mcp-<版本>.zip  = gitrader-mcp.js（取自 packages/mcp/dist，每次现读，不用 cli/dist 里那份副本）
// 纯 Node 写 zip（deflate，固定时间戳，条目按路径排序）：同样的输入 → 同样的字节 → 同样的 sha256，不依赖系统 tar / zip。
// 注意：source.url 仍是将要上传的地址（占位）；size / sha256 是本地这两个 zip 的真实值，产物一变就要重跑本脚本再上传。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const argv = process.argv.slice(2)
const out = resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(root, 'dist-store'))

const cliDist = join(root, 'packages', 'cli', 'dist')
const mcpDist = join(root, 'packages', 'mcp', 'dist')
const need = (p) => { if (!existsSync(p)) throw new Error(`missing build output: ${p}\nbuild first: node scripts/build.mjs cli mcp workbench engine-core`) }

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

/** [{name, data}] → zip Buffer（deflate；时间戳固定为 2026-01-01 00:00:00；UTF-8 文件名标志置位）。 */
function zip(entries) {
  const DOS_TIME = 0
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1
  const parts = []
  const central = []
  let offset = 0
  for (const { name, data } of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const nameBuf = Buffer.from(name, 'utf8')
    const comp = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, comp)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10)
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc >>> 0, 16)
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, nameBuf)
    offset += local.length + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

const fromDir = (dir, include) => walk(dir).map((f) => ({ f, name: relative(dir, f).split('\\').join('/') })).filter((e) => include(e.name)).map((e) => ({ name: e.name, data: readFileSync(e.f) }))

need(join(cliDist, 'bin.js')); need(join(cliDist, 'engine-core.mjs')); need(join(cliDist, 'workbench', 'index.html')); need(join(mcpDist, 'gitrader-mcp.js'))

const appEntries = fromDir(cliDist, (n) => n === 'bin.js' || n === 'bin.js.LEGAL.txt' || n === 'engine-core.mjs' || n.startsWith('workbench/') || n.startsWith('plugins-bundled/') || n.startsWith('examples/'))
const mcpEntries = [{ name: 'gitrader-mcp.js', data: readFileSync(join(mcpDist, 'gitrader-mcp.js')) }]

const recipes = [
  { file: join(here, 'official.gitrader.json'), entries: appEntries },
  { file: join(here, 'official.gitrader-mcp.json'), entries: mcpEntries },
]
mkdirSync(out, { recursive: true })
for (const r of recipes) {
  const recipe = JSON.parse(readFileSync(r.file, 'utf8'))
  const buf = zip(r.entries)
  const zipName = recipe.source.url.split('/').pop()
  writeFileSync(join(out, zipName), buf)
  recipe.source.size = buf.length
  recipe.source.sha256 = createHash('sha256').update(buf).digest('hex')
  writeFileSync(r.file, JSON.stringify(recipe, null, 2) + '\n', 'utf8')
  console.log(`${zipName}  ${buf.length} bytes  sha256 ${recipe.source.sha256}  (${r.entries.length} files)  → ${recipe.id}`)
}
console.log(`written to ${out}`)
