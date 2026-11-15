// SPDX-License-Identifier: CPAL-1.0
// CLI 作为可导入函数提供（本包不加 bin）：run(argv, io?) 返回退出码，不调用 process.exit，测试可直接捕获输出。
import { inspectCandleFile, inspectFundingFile, normalizeCandleFile } from './inspect'
import { manifestFor } from './manifest'
import { renderReport } from './render'
import type { FileKind, Io } from './types'

const USAGE = [
  'usage: data-files <command> [options] <file...>',
  '',
  'commands:',
  '  inspect <file> [--kind=candles|funding]      报告：行数 / 解析数 / 周期 / 缺口 / 重复 / ohlc 违规',
  '  normalize <in.csv|in.json> <out.json>        写成引擎规范 JSON { candles: [...] }',
  '  manifest <file...> [--kind=candles|funding]  清单：绝对路径 + sha256 + format + kind',
  '',
  'options:',
  '  --root=<dir>    可选：数据根目录；给了则读写路径解析后必须落在它里面，越界直接报错',
  '',
  'exit codes: 0 ok, 2 error (usage, unreadable file, bad format)',
].join('\n')

function readKind(value: string): FileKind | null {
  return value === 'candles' || value === 'funding' ? value : null
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 子命令分发。返回 0 = 成功，2 = 用法 / 读文件 / 解析失败（不抛异常）。 */
export async function run(argv: readonly string[], io: Partial<Io> = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => void process.stdout.write(text))
  const err = io.stderr ?? ((text: string) => void process.stderr.write(text))
  try {
    const args = [...argv]
    const cmd = args.shift() ?? ''
    const rootOpts: { root?: string } = {}
    // 不给 --root 时不约束路径（与库函数一致）；给了才启用数据根目录约束。
    if (cmd === '') {
      err(`${USAGE}\n`)
      return 2
    }
    if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
      out(`${USAGE}\n`)
      return 0
    }
    const positional: string[] = []
    let kindValue: string | null = null
    let rootValue: string | null = null
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (a === '--root') {
        const next = args[i + 1]
        // 后面没值，或下一项本身是个选项：不把选项当成目录名。
        if (next === undefined || next.startsWith('--')) {
          err(`--root needs a directory
${USAGE}
`)
          return 2
        }
        rootValue = next
        i++
        continue
      }
      if (a.startsWith('--root=')) {
        rootValue = a.slice('--root='.length)
        continue
      }
      if (a === '--kind') {
        kindValue = args[i + 1] ?? null
        i++
        continue
      }
      if (a.startsWith('--kind=')) {
        kindValue = a.slice('--kind='.length)
        continue
      }
      if (a.startsWith('-')) {
        err(`unknown option: ${a}\n${USAGE}\n`)
        return 2
      }
      positional.push(a)
    }
    if (rootValue !== null && rootValue.trim() === '') {
      err(`--root needs a directory
${USAGE}
`)
      return 2
    }
    if (rootValue !== null) rootOpts.root = rootValue
    const kind = kindValue === null ? 'candles' : readKind(kindValue)
    if (kind === null) {
      err(`unknown kind: ${kindValue ?? ''}\n${USAGE}\n`)
      return 2
    }

    if (cmd === 'inspect') {
      const target = positional[0]
      if (target === undefined || positional.length !== 1) {
        err(`inspect needs exactly one file\n${USAGE}\n`)
        return 2
      }
      const report = kind === 'funding'
        ? inspectFundingFile(target, rootOpts)
        : inspectCandleFile(target, rootOpts)
      out(`${renderReport(report)}\n`)
      return 0
    }
    if (cmd === 'normalize') {
      const [source, target] = positional
      if (source === undefined || target === undefined || positional.length !== 2) {
        err(`normalize needs an input file and an output file\n${USAGE}\n`)
        return 2
      }
      out(`${renderReport(normalizeCandleFile(source, target, rootOpts))}\n`)
      return 0
    }
    if (cmd === 'manifest') {
      if (positional.length === 0) {
        err(`manifest needs at least one file\n${USAGE}\n`)
        return 2
      }
      out(`${renderReport(manifestFor(positional.map((p) => ({ path: p, kind })), rootOpts))}\n`)
      return 0
    }
    err(`unknown command: ${cmd}\n${USAGE}\n`)
    return 2
  } catch (e) {
    err(`error: ${messageOf(e)}\n`)
    return 2
  }
}

/** 同一函数的收集版：返回 {code,stdout,stderr}，便于脚本与测试直接拿文本。 */
export async function runCaptured(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await run(argv, {
    stdout: (text: string) => {
      stdout += text
    },
    stderr: (text: string) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}
