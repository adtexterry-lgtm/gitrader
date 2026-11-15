// SPDX-License-Identifier: CPAL-1.0
// 用 packages/protocol/conformance/gsp 小套件跑本插件的 stdio 实现（G01–G08），照
// packages/plugin-notify-telegram/run-conformance.mjs 的写法。全程离线：假 fetch 由插件内置，
// 通过 GITRADER_PLUGIN_FAKE_FETCH=1 打开，webhook 用固定夹具值（不是真 webhook）。
//
// 清单与运行时只认协议合法名 notify_send；B0 契约的点号名由内核侧映射，插件不再接受别名。
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const tool = 'notify_send'

const TOOL_CASE = {
  tool,
  args: {
    notice: {
      key: 'conformance:notify.send',
      level: 'warn',
      title: 'Risk denial',
      lines: ['account acct_x', 'notional 1200 > 1000'],
      ts: 1760000000000,
      topic: 'risk.denials',
    },
    params: {},
  },
  expected: { ok: true },
}

const env = {
  ...process.env,
  GSP_LAUNCH: JSON.stringify({
    command: process.execPath,
    args: [resolve(here, 'gsp.mjs')],
    cwd: here,
    env: {
      GITRADER_PLUGIN_FAKE_FETCH: '1',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T00000000/B00000000/conformance-fixture-webhook',
    },
  }),
  GSP_TOOL_CASE: JSON.stringify(TOOL_CASE),
}
delete env.GSP_ENDPOINT

process.stderr.write(`[conformance] tool=${tool} (真实清单)\n`)
const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', '../../vitest.config.ts', '--root', 'packages/protocol',
  'conformance/gsp', '--fileParallelism=false',
], { cwd: root, env, stdio: 'inherit', windowsHide: true })
process.exit(result.status ?? 1)
