// SPDX-License-Identifier: CPAL-1.0
// 用协议包的 GSP 一致性小套件（G01–G08）跑本插件：把 gsp.mjs 作为 stdio 目标拉起，
// 工具用例走 notify.send，网络用 GITRADER_PLUGIN_FAKE_FETCH=1 的假响应（不出网，不需要密钥）。
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
      notice: { key: 'risk.denials:acct_x:ruleY', level: 'warn', title: 'Risk denial', lines: ['account acct_x', 'rule Y'], ts: 1760000000000, topic: 'risk.denials' },
      params: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/conformance' },
    },
    expected: { ok: true, ref: 'fake-webhook-1' },
  }),
}
delete env.GSP_ENDPOINT

const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', '../../vitest.config.ts', '--root', 'packages/protocol',
  'conformance/gsp', '--fileParallelism=false',
], { cwd: root, env, stdio: 'inherit', windowsHide: true })
process.exit(result.status ?? 1)
