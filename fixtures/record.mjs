// SPDX-License-Identifier: CPAL-1.0
// 夹具录制脚本：把 Hyperliquid 的 info 原始响应存进 fixtures/hl/。**不是测试的一部分，测试全部离线。**
//   node fixtures/record.mjs --env testnet [--coins BTC,ETH] [--dexes xyz] [--max-weight 100]
//   node fixtures/record.mjs --env mainnet --yes-mainnet ...
// 约束：
//   · 每次运行先估算总权重（官方口径：allMids / l2Book = 2，K 线 20 + 条数/60，其余 20），超过 --max-weight（默认 100）直接拒绝；
//   · 同一台机器只允许一个连真数据的实例——录主网前先确认没有别的实例在连（Demo 实例占着时不要录）；
//   · 请求之间至少间隔 1 s；只发 POST /info，只读。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const env = flag('env', 'testnet')
const coins = flag('coins', 'BTC').split(',').filter(Boolean)
const dexes = flag('dexes', '').split(',').filter(Boolean)
const maxWeight = Number(flag('max-weight', '100'))
if (env === 'mainnet' && !args.includes('--yes-mainnet')) {
  console.error('refusing to record from mainnet without --yes-mainnet')
  process.exit(2)
}
const base = env === 'mainnet' ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info'
const out = join(dirname(fileURLToPath(import.meta.url)), 'hl', `recorded-${env}`)
mkdirSync(out, { recursive: true })

const now = Date.now()
const jobs = [
  { file: 'perpDexs.json', body: { type: 'perpDexs' }, weight: 20 },
  { file: 'metaAndAssetCtxs.json', body: { type: 'metaAndAssetCtxs' }, weight: 20 },
  { file: 'allMids.json', body: { type: 'allMids' }, weight: 2 },
  ...dexes.flatMap((d) => [
    { file: `metaAndAssetCtxs-${d}.json`, body: { type: 'metaAndAssetCtxs', dex: d }, weight: 20 },
    { file: `allMids-${d}.json`, body: { type: 'allMids', dex: d }, weight: 2 },
  ]),
  ...coins.flatMap((c) => [
    { file: `l2Book-${c.replace(':', '_')}.json`, body: { type: 'l2Book', coin: c }, weight: 2 },
    { file: `candleSnapshot-${c.replace(':', '_')}-1m.json`, body: { type: 'candleSnapshot', req: { coin: c, interval: '1m', startTime: now - 61 * 60_000, endTime: now } }, weight: 20 + 2 },
  ]),
]
const total = jobs.reduce((s, j) => s + j.weight, 0)
console.log(`plan: ${jobs.length} requests, estimated weight ${total} (limit per minute 1200, cap this run ${maxWeight})`)
if (total > maxWeight) {
  console.error(`estimated weight ${total} exceeds --max-weight ${maxWeight}; reduce --coins / --dexes or raise the cap on purpose`)
  process.exit(2)
}
for (const j of jobs) {
  const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j.body) })
  const text = await res.text()
  if (!res.ok) { console.error(`${j.file}: HTTP ${res.status} ${text.slice(0, 200)}`); continue }
  writeFileSync(join(out, j.file), JSON.stringify(JSON.parse(text), null, 1) + '\n')
  console.log(`recorded ${j.file}`)
  await new Promise((r) => setTimeout(r, 1000))
}
