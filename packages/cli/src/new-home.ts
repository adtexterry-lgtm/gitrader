// SPDX-License-Identifier: CPAL-1.0
// 新建数据目录时的产品默认值（ADR-3）：只在这一次新建 gitrader.json 时写入；已有配置一律不动。
// 放在 CLI 而不是内核的 defaultConfig()：内核默认值同时是老策略、老测试夹具的口径，字段缺省 = 不要求。
import { readFileSync, writeFileSync } from 'node:fs'
import { initHome } from '@gitrader/kernel'
import type { InitOptions } from '@gitrader/kernel'

/** 新 home 的风控默认：Agent 开仓必须带止损（纸面与实盘同一规则；关掉要在工作台用 PIN 放宽）。 */
export const NEW_HOME_RISK_DEFAULTS = { requireStopOnAgentOpen: true } as const

export function initHomeWithDefaults(home: string, opts?: InitOptions): ReturnType<typeof initHome> {
  const r = initHome(home, opts)
  if (!r.created.includes(r.paths.config)) return r
  const config = JSON.parse(readFileSync(r.paths.config, 'utf8')) as { risk?: Record<string, unknown> }
  config.risk = { ...NEW_HOME_RISK_DEFAULTS, ...(config.risk ?? {}) }
  writeFileSync(r.paths.config, JSON.stringify(config, null, 2) + '\n')
  return { ...r, config: { ...r.config, risk: { ...r.config.risk, ...NEW_HOME_RISK_DEFAULTS } } }
}
