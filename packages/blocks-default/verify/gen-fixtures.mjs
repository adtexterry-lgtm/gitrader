// SPDX-License-Identifier: CPAL-1.0
// 由 fixtures/scenarios.ts 生成各块清单里引用的离线回放文件 fixtures/<块>.json（BlockFixtures：events / queries）。
// 用法：node verify/gen-fixtures.mjs   （packages/blocks-default 下）。夹具里的时间相对 _now，预览时按当前时间平移。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const tdir = join(here, '.tmp')
mkdirSync(tdir, { recursive: true })
const out = join(tdir, 'scenarios.mjs')
await build({ entryPoints: [join(root, 'fixtures/scenarios.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { scenario, NOW, ACCT_LIVE, O_CLAUDE, entry } = await import(pathToFileURL(out).href)

const sc = scenario('pending')
const live = sc.accounts.filter((a) => a.accountId === ACCT_LIVE)
const activityTypes = ['order.intent', 'risk.denied', 'order.rejected', 'order.cancelled', 'fill', 'proposal.created', 'proposal.decided', 'proposal.executed', 'proposal.failed', 'proposal.expired', 'proposal.withdrawn', 'takeover.requested', 'takeover.completed', 'takeover.failed', 'mandate.downgraded', 'mandate.issued', 'mandate.changed', 'mandate.revoked', 'protector.triggered', 'trading_state.changed', 'note']
const ledgerDesc = [...sc.ledger].sort((a, b) => b.seq - a.seq)
const common = { _now: NOW }
const files = {
  positions: {
    ...common,
    events: [],
    queries: {
      'account.list': live,
      'account.summary': sc.summaries[ACCT_LIVE],
      'account.positions': sc.positions[ACCT_LIVE],
      'account.fills': sc.fills[ACCT_LIVE],
      'account.orders': sc.orders[ACCT_LIVE],
      'ledger.query': sc.ledger.filter((e) => e.subject.instrumentId === 'hyperliquid:BTC').sort((a, b) => a.seq - b.seq),
      'agentkey.list': sc.keys,
      'proposal.list': scenario('normal').proposals,
    },
  },
  'agent-activity': {
    ...common,
    events: [
      { t: 1500, topic: 'ledger.entry', data: entry(990, 'note', O_CLAUDE, { orgId: 'org_local' }, { text: '回放中的新动作：继续观察' }, NOW + 1500) },
    ],
    queries: {
      'ledger.query': ledgerDesc.filter((e) => activityTypes.includes(e.type)),
      'proposal.list': sc.proposals,
      'agentkey.list': sc.keys,
      'mandate.list': sc.mandates,
      'account.list': live,
      'risk.state': sc.risk,
      // r4 待批卡的批后仓位（IA §2.3）
      'account.summary': sc.summaries[ACCT_LIVE],
      'account.positions': sc.positions[ACCT_LIVE],
    },
  },
  risk: {
    ...common,
    events: [{ t: 2500, topic: 'risk.state', data: { kind: 'policy', version: 4, ts: NOW + 2500 } }],
    queries: {
      'risk.state': sc.risk,
      'ledger.query': ledgerDesc.filter((e) => e.type === 'protector.triggered'),
      'account.list': live,
      'account.summary': sc.summaries[ACCT_LIVE],
      'account.positions': sc.positions[ACCT_LIVE],
      'proposal.list': sc.proposals, // r4：待批为 0 张时保护器列表自动展开
    },
  },
  statusbar: {
    ...common,
    events: [{ t: 2000, topic: 'venue.status', data: { ...sc.venues[0], latencyMs: { p50: 37, p95: 70 } } }],
    // r4 总览条：实盘权益与今日、待批张数与最急（回放桥对同一查询不分参数，账户只放实盘一个）
    queries: { 'venue.status': sc.venues, 'risk.state': sc.risk, 'account.list': live, 'account.summary': sc.summaries[ACCT_LIVE], 'account.positions': sc.positions[ACCT_LIVE], 'proposal.list': sc.proposals },
  },
}
mkdirSync(join(root, 'fixtures'), { recursive: true })
for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'fixtures', `${name}.json`), JSON.stringify(body, null, 2) + '\n')
console.log('fixtures written:', Object.keys(files).join(', '))
