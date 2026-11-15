#!/usr/bin/env node
// SPDX-License-Identifier: CPAL-1.0
import { formatFatal } from './fatal'
import type { CliIo } from './index'
import { resolveLang } from './lang'

// node:sqlite 在 Node 22 里还标着 experimental，每次启动会打一行警告——对命令行用户是噪音，只过滤这一条，其他警告照常。
// 打包后 node:sqlite 的 import 会被提到文件最前、早于这里的代码，所以不能改 emitWarning，要换掉 'warning' 事件的默认打印监听器。
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return
  process.stderr.write(`(node:${process.pid}) ${w.name}: ${w.message}\n`)
})
const { main } = await import('./index')

async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt)
  const stdin = process.stdin
  if (!stdin.isTTY) {
    // 非终端：从 stdin 读一行（脚本 / 管道）
    return await new Promise<string>((resolve) => {
      let buf = ''
      const onData = (c: Buffer): void => { buf += c.toString('utf8'); const i = buf.indexOf('\n'); if (i >= 0) { stdin.off('data', onData); stdin.pause(); resolve(buf.slice(0, i).replace(/\r$/, '')) } }
      stdin.on('data', onData)
      stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')))
      stdin.resume()
    })
  }
  return await new Promise<string>((resolve) => {
    let s = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (c: Buffer): void => {
      for (const ch of c.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.off('data', onData); stdin.pause(); process.stderr.write('\n'); resolve(s); return }
        if (ch === '\u0003') { stdin.setRawMode(false); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1)
        else s += ch
      }
    }
    stdin.on('data', onData)
  })
}

const io: CliIo = {
  out: (s) => { process.stdout.write(s) },
  err: (s) => { process.stderr.write(s) },
  env: process.env,
  readSecret,
  interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
  stdinTty: !!process.stdin.isTTY,
}
const argv = process.argv.slice(2)
const debug = argv.includes('--debug') || process.env.GITRADER_DEBUG === '1'
// serve 正常返回后显式退出：内核的监听 / 定时器可能还挂着，靠 exitCode 让进程自然退出会挂住。
const isServe = argv.find((a) => !a.startsWith('--')) === 'serve'
main(argv, io).then((code) => {
  if (isServe) process.exit(code)
  else process.exitCode = code
}, (e) => { process.stderr.write(`${formatFatal(e, { debug, nonInteractive: !io.interactive, lang: resolveLang(argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined, process.env), env: process.env })}\n`); process.exitCode = 1 })
