// SPDX-License-Identifier: CPAL-1.0
// 教程 03 用：往一个主目录的 gitrader.json 里加一条 webhook 通知通道。
//
//   node docs/user/tutorials/add-notify-channel.mjs --home <主目录> --id main --url http://127.0.0.1:8787/hook
//
// 它只做三处最小改动（其余键原样保留，不改 accountId 等内核生成的值）：
//   1. plugins.developerMode = true          —— 本仓的通道插件未签名，本地开发期只有这样才会被加载
//   2. plugins.secrets[插件 id].WEBHOOK_SECRET = "env:WEBHOOK_SECRET"
//                                             —— 配置里只放环境变量句柄，密钥值放启动内核的进程环境
//   3. notify.channels += { id, plugin, minLevel, params: { url } }
//
// 这里只做参数形状自检；整份配置的正式校验由内核自己做——紧接着的 `notify test` 会拉起内核读这份配置，
// 写错了那一步会直接把 Problem 报出来。不从源码 import 内核的原因：内核源码用到 TypeScript 的参数属性
// （`constructor(readonly problem: Problem)`），Node 的类型擦除模式不吃这种语法。
// 不联网、不读密钥、不写 --home 以外的任何路径。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const homeArg = arg('home', null)
const id = arg('id', 'main')
const url = arg('url', null)
const plugin = arg('plugin', 'connector.gitrader.notify-webhook')
const minLevel = arg('min-level', 'info')

if (!homeArg || !url) {
  process.stderr.write('用法：node docs/user/tutorials/add-notify-channel.mjs --home <主目录> --url <webhook 地址> [--id main] [--min-level info]\n')
  process.exit(2)
}
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
  process.stderr.write(`通道 id 不合法：${id}（字母数字开头，最长 64，可有 - 和 _）\n`)
  process.exit(2)
}
if (!/^https?:\/\//.test(url)) {
  process.stderr.write(`url 只接受 http: / https:，收到 ${url}\n`)
  process.exit(2)
}
if (!['info', 'warn', 'critical'].includes(minLevel)) {
  process.stderr.write(`--min-level 只能是 info / warn / critical，收到 ${minLevel}\n`)
  process.exit(2)
}

const home = resolve(homeArg)
const file = join(home, 'gitrader.json')
const cfg = JSON.parse(readFileSync(file, 'utf8'))

cfg.plugins = cfg.plugins ?? {}
cfg.plugins.developerMode = true
cfg.plugins.secrets = cfg.plugins.secrets ?? {}
cfg.plugins.secrets[plugin] = { ...(cfg.plugins.secrets[plugin] ?? {}), WEBHOOK_SECRET: 'env:WEBHOOK_SECRET' }

const channels = (cfg.notify?.channels ?? []).filter((c) => c?.id !== id)
channels.push({ id, plugin, minLevel, params: { url } })
cfg.notify = {
  ...(cfg.notify ?? {}),
  channels,
  rules: cfg.notify?.rules ?? [{ match: '*', level: 'warn', channels: [id] }],
}

writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
process.stdout.write(
  `已写入通道 ${id} → ${plugin}（minLevel ${minLevel}）\n` +
  `  地址 ${url}\n  配置 ${file}\n  密钥句柄 env:WEBHOOK_SECRET（值请放在启动内核的进程环境里）\n`)
