// SPDX-License-Identifier: CPAL-1.0
// `gitrader accounts watch <0x地址>`：加一个只读观察账户（R3-20）。
// 只写 gitrader.json 的一条 accounts 记录（mode: 'watch' + 公开地址）；不碰钥匙、不要 PIN、不连任何网。
// 观察账户按地址读场所公开的账户状态（持仓、余额），内核里没有任何下单路径通向它。
// 观察账户按自己的 --network 读公开数据，与交易场所连的是哪个网无关（交易场所留在测试网也能看主网地址）。
import { KernelError, loadConfig, saveConfig } from '@gitrader/kernel'
import type { ConfigAccount } from '@gitrader/kernel'
import { isWatchAddress } from '../../kernel/src/watch'
import { flag, liveService } from './index'
import type { Args, CliIo } from './index'
import { initHomeWithDefaults } from './new-home'

const USAGE = 'usage: gitrader accounts watch <0x地址> [--alias <名字>] [--network mainnet|testnet]\n'

export async function cmdAccounts(home: string, a: Args, io: CliIo): Promise<number> {
  const [, sub, address] = a.cmd
  if (sub !== 'watch' || !address || a.cmd.length !== 3) { io.err(USAGE); return 1 }
  if (!isWatchAddress(address)) {
    io.err(`地址不对：要 0x 加 40 位十六进制（收到：${address.slice(0, 12)}${address.length > 12 ? '…' : ''}）。配置文件没有改。\n`)
    return 1
  }
  const network = flag(a, 'network') ?? 'mainnet'
  if (network !== 'mainnet' && network !== 'testnet') { io.err(`--network 只能是 mainnet 或 testnet（收到：${network}）。配置文件没有改。\n`); return 1 }
  const alias = flag(a, 'alias') ?? `watch-${address.slice(2, 8).toLowerCase()}`

  initHomeWithDefaults(home)
  let cfg
  try { cfg = loadConfig(home) } catch (e) { io.err(`error: ${e instanceof KernelError ? e.problem.message : e instanceof Error ? e.message : String(e)}\n`); return 1 }

  const same = cfg.accounts.find((x) => (x.mode as string) === 'watch' && x.watch?.address.toLowerCase() === address.toLowerCase() && x.environment === network)
  if (same) { io.out(`已经在观察这个地址了：${same.alias}（${network}）。没有改动。\n`); return 0 }
  if (cfg.accounts.some((x) => x.alias === alias)) { io.err(`已经有一个叫 ${alias} 的账户。换一个名字：--alias <名字>。配置文件没有改。\n`); return 1 }
  const venue = cfg.venues.find((v) => v.id === 'hyperliquid')
  if (!venue) { io.err('配置里没有 hyperliquid 场所，观察账户（目前只支持 hyperliquid）没有数据来源。配置文件没有改。\n'); return 1 }

  const entry = { alias, mode: 'watch', venue: 'hyperliquid', environment: network, watch: { address } } as unknown as ConfigAccount
  try { saveConfig(home, { ...cfg, accounts: [...cfg.accounts, entry] }) } catch (e) {
    io.err(`error: ${e instanceof KernelError ? e.problem.message : e instanceof Error ? e.message : String(e)}\n配置文件没有改。\n`)
    return 1
  }
  initHomeWithDefaults(home) // 补上账户 id
  io.out(`已加观察账户 ${alias}：${address}（hyperliquid ${network}）。只读：能看持仓和余额，不能下单，不需要任何钥匙。\n`)
  io.out((await liveService(home))
    ? '服务正在运行：重启后生效（先 gitrader stop，再 gitrader serve）/ the service is running: restart it for the new account to appear.\n'
    : '下次 gitrader serve 起来就能看到它 / it appears the next time you run gitrader serve.\n')
  io.out(`给 AI 看它：gitrader keys new agent <名字> --host claude-code --tier read_only --accounts ${alias}\n`)
  return 0
}
