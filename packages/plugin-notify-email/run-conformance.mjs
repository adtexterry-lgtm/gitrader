// SPDX-License-Identifier: CPAL-1.0
// 跑 packages/protocol/conformance/gsp 小套件（G01–G08），用 stdio 拉起本插件（照 python-plugin/run-conformance.mjs 的写法）。
// 插件在假连接模式（GITRADER_PLUGIN_FAKE_FETCH=1）下跑，不发任何真实邮件；工具用例走 notify.send。
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const env = {
  ...process.env,
  GSP_LAUNCH: JSON.stringify({
    command: process.execPath,
    args: [resolve(here, 'gsp.mjs')],
    cwd: here,
    env: { GITRADER_PLUGIN_FAKE_FETCH: '1' },
  }),
  GSP_TOOL_CASE: JSON.stringify({
    tool: 'notify_send',
    args: {
      notice: {
        key: 'risk.denials:acct_fixture:ruleA',
        level: 'warn',
        title: 'Risk denial',
        lines: ['account acct_fixture', 'rule ruleA', 'notional 1200 > 1000'],
        ts: 1760000000000,
        topic: 'risk.denials',
      },
      params: { host: 'localhost', port: 2525, secure: false, from: 'bot@localhost', to: ['ops@localhost'] },
    },
    expected: { ok: true, ref: 'fake-smtp-1' },
  }),
}
delete env.GSP_ENDPOINT
const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', '../../vitest.config.ts', '--root', 'packages/protocol',
  'conformance/gsp', '--fileParallelism=false',
], { cwd: root, env, stdio: 'inherit', windowsHide: true })
process.exit(result.status ?? 1)
