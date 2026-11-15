// SPDX-License-Identifier: CPAL-1.0
// `gitrader keys rotate agent <名字或keyId> [--token-file <路径>]`：换令牌（PIN），旧令牌立即失效，不留宽限期。
import { resolve } from 'node:path'
import { mkOrigin } from '@gitrader/kernel'
import { writeTokenFile } from '../../kernel/src/token-file'
import { writeSecretFile } from '../../kernel/src/util/fsperm'
import { flag, needPin, openKernel } from './index'
import type { Args, CliIo } from './index'

export async function cmdKeysRotate(home: string, a: Args, io: CliIo): Promise<number> {
  const id = a.cmd[3]
  if (!id) throw new Error('用法：gitrader keys rotate agent <名字或 id> [--token-file <路径>]')
  const k = await openKernel(home, io)
  try {
    const key = k.agents.listKeys().find((x) => x.keyId === id || x.name === id)
    if (!key) throw new Error(`没有这把 Agent 钥匙：${id}（用 gitrader keys list 查看名字）`)
    if (key.status !== 'active') throw new Error(`这把钥匙已${key.status === 'revoked' ? '吊销' : '过期'}，不能轮换；请新建一把`)
    const proof = await needPin(k, io)
    const r = k.agents.rotateKey(key.keyId, proof, mkOrigin('user:usr_local', 'cli:keys.rotate', 'cli'))
    const target = flag(a, 'token-file')
    const warn = (p: string): void => io.err(`警告：令牌文件 ${p} 的权限没能收紧，请自行限制只有你能读\n`)
    const path = target ? resolve(target) : writeTokenFile(home, key.name, r.token, warn)
    if (target) { const tight = writeSecretFile(path, `${r.token}\n`); if (tight === false) warn(path) }
    io.out(`已轮换 Agent 钥匙「${key.name}」：旧令牌立即失效，新令牌已写入 ${path}（令牌不打印）。\n` +
      '宿主用环境变量 GITRADER_AGENT_TOKEN 的要重启；用令牌文件的把 GITRADER_AGENT_TOKEN_FILE 指向它（或用 --token-file 覆盖原文件，宿主下一次调用自动读到新令牌）。\n')
    return 0
  } finally { await k.stop() }
}
