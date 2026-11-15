// SPDX-License-Identifier: Apache-2.0
// 假引擎的 stdio 入口（NDJSON）：用来验证套件的 stdio 传输与"任意语言子进程"这条路。
// 令牌取环境变量 GITRADER_GEP_TOKEN（契约 §2.1）。stderr 只放日志。
import { createInterface } from 'node:readline'
import { FakeEngine } from './fake-engine'
import type { MemoryEndpoint } from './transport'

let onMessage: (t: string) => void = () => {}
let onClose: () => void = () => {}
const endpoint: MemoryEndpoint = {
  send: (text) => { process.stdout.write(`${text}\n`) },
  onMessage: (cb) => { onMessage = cb },
  onClose: (cb) => { onClose = cb },
  close: () => { onClose(); process.exit(0) },
}
const engine = new FakeEngine({
  token: process.env['GITRADER_GEP_TOKEN'] ?? '',
  heartbeatTimeoutMs: Number(process.env['FAKE_GEP_HB_TIMEOUT_MS'] ?? 15000),
  onExit: () => process.exit(0),
})
engine.accept(endpoint)
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => { if (line.trim()) onMessage(line) })
rl.on('close', () => { onClose(); process.exit(0) })
process.stderr.write('fake gep engine ready\n')
