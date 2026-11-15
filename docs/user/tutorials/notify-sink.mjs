// SPDX-License-Identifier: CPAL-1.0
// 教程 03 用：本地通知接收器（自建 webhook 的假端点）。
//
//   node docs/user/tutorials/notify-sink.mjs --port 8787
//
// 起一个只听 127.0.0.1 的 HTTP 服务，每收到一条请求就打印方法、路径和正文，回 {"ok":true}。
// 用来在没有飞书 / 钉钉 / Slack 的情况下验证「内核 → 通知出口 → 插件 → 你的端点」这条链路是否通。
// 只绑本机回环地址，不联网、不需要密钥；Ctrl+C 停止。
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const port = Number(arg('port', '8787'))
const path = arg('path', '/hook')

let count = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    count += 1
    const at = new Date().toISOString()
    process.stdout.write(`#${count} ${at} ${req.method} ${req.url}\n  ${body || '(空正文)'}\n`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`通知接收器已起：http://127.0.0.1:${port}${path}（Ctrl+C 停止）\n`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    process.stdout.write(`收到 ${count} 条通知，停止。\n`)
    server.close(() => process.exit(0))
  })
}
