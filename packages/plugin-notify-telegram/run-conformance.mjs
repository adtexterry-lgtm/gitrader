// SPDX-License-Identifier: CPAL-1.0
// 用 packages/protocol/conformance/gsp 小套件跑本插件的 stdio 实现（G01–G08），照
// packages/protocol/examples/python-plugin/run-conformance.mjs 的写法。全程离线：假 fetch 由插件内置，
// 通过 GITRADER_PLUGIN_FAKE_FETCH=1 打开，令牌用固定夹具值（不是真密钥）。
//
// 清单里 tools[].name 是协议合法名 notify_send，默认跑法即 G01–G08 全过；
// 插件运行时同时接受 B0 契约的 notify.send 别名。
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
    params: { chatId: '123' },
  },
  expected: { ok: true, ref: '4242' },
}

const env = {
  ...process.env,
  GSP_LAUNCH: JSON.stringify({
    command: process.execPath,
    args: [resolve(here, 'gsp.mjs')],
    cwd: here,
    env: { GITRADER_PLUGIN_FAKE_FETCH: '1', TELEGRAM_BOT_TOKEN: 'conformance-fixture-token' },
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
