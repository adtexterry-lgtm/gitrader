// SPDX-License-Identifier: CPAL-1.0
// 随包资源安装：`gitrader plugins install` 与 `gitrader examples copy`
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinPluginDir, inspectPluginDir, homePaths, loadConfig, readBundledHashes, BUNDLED_HASHES_FILE, KERNEL_VERSION } from '@gitrader/kernel'
import type { CliIo, Args } from './index'

/** dist/<子目录>：随包资源。bin.js 是单文件打包，import.meta.url 的目录就是 dist/；开发时（tsx 跑 src）退到 ../dist。 */
export function locateBundled(sub: 'plugins-bundled' | 'examples', here = dirname(fileURLToPath(import.meta.url))): string | undefined {
  for (const p of [join(here, sub), join(here, '..', 'dist', sub)]) if (existsSync(p)) return p
  return undefined
}

/** gitrader plugins install [<名>] [--force]：不给名字 = 列出随包插件。 */
export async function cmdPluginsInstall(home: string, a: Args, io: CliIo, bundledRoot = locateBundled('plugins-bundled')): Promise<number> {
  if (!bundledRoot) {
    io.err('这份安装里没有随包插件（可能是从源码树运行）\n')
    return 1
  }

  const available = readdirSync(bundledRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const name = a.cmd[2]  // 'plugins install <name>' → cmd[2]

  if (!name) {
    io.out('随包通知插件：\n')
    for (const n of available) {
      const manifestPath = join(bundledRoot, n, 'gitrader-plugin.json')
      if (existsSync(manifestPath)) {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
        io.out(`  ${n.padEnd(20)} ${m.name || ''}\n`)
      } else {
        io.out(`  ${n}\n`)
      }
    }
    io.out('\n使用：gitrader plugins install <名>\n')
    return 0
  }

  if (!available.includes(name)) {
    io.err(`插件 ${name} 不存在。可用：${available.join(', ')}\n`)
    return 1
  }

  const src = join(bundledRoot, name)
  const dest = join(homePaths(home).plugins, name)

  if (existsSync(dest) && !a.flags['force']) {
    io.err(`${dest} 已存在。服务在跑时先停（Windows 下运行中的插件目录无法替换）。要覆盖用 --force\n`)
    return 1
  }

  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  const pinResult = pinPluginDir(dest)
  io.out(`已装到 ${dest}（随包，未联网）\n`)
  io.out(`钉版本：${pinResult.files} 个文件，sha256 = ${pinResult.sha256.slice(0, 16)}...\n`)

  // 自检：developerMode 从配置读
  let developerMode = false
  try {
    const cfg = loadConfig(home)
    developerMode = cfg.plugins?.developerMode ?? false
  } catch {
    // 配置读不到按 false
  }

  // R2-REL-10：随包插件靠产品清单（BUNDLED-HASHES.json，和随包插件放在同一个产品目录里）获得信任，不需要打开开发者模式
  const inspection = inspectPluginDir(dest, { developerMode, trustRoots: [], kernelVersion: KERNEL_VERSION, bundledHashes: readBundledHashes(join(bundledRoot, BUNDLED_HASHES_FILE)) })
  if (inspection.ok) {
    io.out(inspection.trusted ? '校验通过（随包内置信任：内容和本版本发布的哈希清单一致）\n' : '校验通过（已打开开发者模式）\n')
  } else {
    io.out(`校验问题：${inspection.problems.map((p) => p.code).join(', ')}\n`)
    if (inspection.problems.some((p) => p.code === 'UNSIGNED_NOT_ALLOWED')) {
      io.out('\n这份随包插件和本版本发布的哈希清单（BUNDLED-HASHES.json）对不上，或安装里没有这份清单：请重新安装 gitrader，不要手工改随包插件\n')
      io.out('（自己改过的插件属于开发者用法，见 docs/user/07-插件.md §6）\n')
    }
  }

  io.out('\n下一步：\n')
  io.out('  gitrader plugins reload\n')
  io.out(`  gitrader plugins grant ${name} net.fetch  （先停服务）\n`)
  io.out('  配置 notify.channels（见 docs/user/06-通知配置.md §3）\n')
  return 0
}

/** gitrader examples list | copy <名> [--force] */
export async function cmdExamples(home: string, a: Args, io: CliIo, bundledRoot = locateBundled('examples')): Promise<number> {
  if (!bundledRoot) {
    io.err('这份安装里没有随包示例（可能是从源码树运行）\n')
    return 1
  }

  const sub = a.cmd[1]
  if (sub === 'list') {
    const strategiesDir = join(bundledRoot, 'strategies')
    const template = join(bundledRoot, 'strategy-template.ts')
    io.out('随包示例策略：\n')
    if (existsSync(strategiesDir)) {
      for (const f of readdirSync(strategiesDir)) {
        if (f.endsWith('.ts')) io.out(`  ${f.slice(0, -3)}\n`)
      }
    }
    if (existsSync(template)) io.out('  template  （空白模板）\n')
    io.out('\n使用：gitrader examples copy <名>\n')
    return 0
  }

  if (sub !== 'copy') {
    io.err('用法：gitrader examples list | copy <名>\n')
    return 1
  }

  const name = a.cmd[2]
  if (!name) {
    io.err('用法：gitrader examples copy <名>\n')
    return 1
  }

  let srcFile: string | undefined
  if (name === 'template') {
    srcFile = join(bundledRoot, 'strategy-template.ts')
  } else {
    const candidate = join(bundledRoot, 'strategies', `${name}.ts`)
    if (existsSync(candidate)) srcFile = candidate
  }

  if (!srcFile || !existsSync(srcFile)) {
    io.err(`示例 ${name} 不存在。用 gitrader examples list 查看可用示例\n`)
    return 1
  }

  const destDir = join(home, 'engines', 'gitrader-core', 'strategies')
  mkdirSync(destDir, { recursive: true })
  const destFile = join(destDir, name === 'template' ? 'template.ts' : `${name}.ts`)

  if (existsSync(destFile) && !a.flags['force']) {
    io.err(`${destFile} 已存在。要覆盖用 --force\n`)
    return 1
  }

  cpSync(srcFile, destFile)
  io.out(`已拷到 ${destFile}\n`)
  io.out('改文件里的 id 与 name；引擎约 1 秒内校验并热加载\n')
  return 0
}
