// SPDX-License-Identifier: CPAL-1.0
// gitrader pin reset：忘了 PIN 时在本机终端里重置（ADR-4）。
// 会备份并停用钥匙库、吊销全部 AI 钥匙；账本、历史记录与安装签名身份保留。之后走现有的设 PIN 流程。
import { basename } from 'node:path'
import { resetPin } from '@gitrader/kernel'
import { liveService, needPin, openKernel } from './index'
import type { Args, CliIo } from './index'

const CONFIRM_PHRASE = '我确认重置 PIN'
const NO_TTY = '重置 PIN 只能在本机终端里由你本人完成'
const PROMPT = `输入「${CONFIRM_PHRASE}」继续：`

const COST = `重置 PIN 会做这些事：
  - 把 keys/pin.json、keys/keystore.json 与 keys/device.key.json 移到 keys.bak-… 备份目录，并用新 PIN 重建：钥匙库停用，
    API 钱包私钥需要你用自己另存的私钥重新 gitrader keys import；
  - 吊销全部 AI 钥匙（之后用 gitrader keys new agent … 重建）；
  - 账本、历史记录与签名身份保留。

`

/** CliIo 只有 readSecret（隐藏输入）；测试 / 宿主可以额外注入普通读行的 readLine。 */
type LineReader = CliIo & { readLine?: (prompt: string) => Promise<string> }

export async function cmdPinReset(home: string, _a: Args, io: CliIo, deps: { liveService?: typeof liveService } = {}): Promise<number> {
  const pinFromStdin = typeof io.env.GITRADER_PIN_STDIN === 'string' && io.env.GITRADER_PIN_STDIN !== ''
  if (!io.interactive || pinFromStdin) {
    io.err(`${NO_TTY}\n`)
    return 2
  }
  // 服务还在跑就先说清楚怎么停，不让用户先读完代价、打完确认语才被拒（内核 resetPin 里的检查留作竞态兜底）
  const live = await (deps.liveService ?? liveService)(home)
  if (live) {
    io.err(`服务还在运行（端口 ${live.port}）。先运行 gitrader stop 停掉它，再重置 PIN。\n`)
    return 1
  }
  io.out(COST)
  const readLine = (io as LineReader).readLine
  const answer = readLine ? await readLine(PROMPT) : await io.readSecret(PROMPT)
  if (answer.trim() !== CONFIRM_PHRASE) {
    io.out('已取消\n')
    return 1
  }

  const result = await resetPin(home, { log: (m) => io.err(`${m}\n`) })
  const k = await openKernel(home, io)
  try { await needPin(k, io) } finally { await k.stop() }
  io.out(`PIN 已重置。备份在 ${basename(result.backupDir)}。下一步：gitrader serve，然后重建 AI 钥匙：gitrader keys new agent …\n`)
  return 0
}
