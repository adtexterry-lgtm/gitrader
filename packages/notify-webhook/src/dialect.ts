// SPDX-License-Identifier: CPAL-1.0
// Webhook 方言识别。起点复制自 packages/kernel/src/notify/webhook.ts（该文件为本内核移植版），
// 本库补齐 QD 的企业微信（wecom）与 discord 规则，此后以本库为准。

/** 支持的厂商方言；`generic` 是自建 / 未知端点。 */
export type WebhookDialect = 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'discord' | 'generic'

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:12-31; adapted.
// 按 URL 路径特征表识别厂商；discord 一段是本库补充（QD 未覆盖）。
const DIALECT_PATTERNS: ReadonlyArray<readonly [WebhookDialect, readonly string[]]> = [
  ['feishu', [
    'open.feishu.cn/open-apis/bot/v2/hook/',
    'open.larksuite.com/open-apis/bot/v2/hook/',
    'open.larkoffice.com/open-apis/bot/v2/hook/',
    'www.larksuite.com/open-apis/bot/v2/hook/',
  ]],
  ['dingtalk', ['oapi.dingtalk.com/robot/send']],
  ['wecom', ['qyapi.weixin.qq.com/cgi-bin/webhook/send']],
  ['slack', ['hooks.slack.com/services/']],
  ['discord', ['discord.com/api/webhooks', 'discordapp.com/api/webhooks']],
]

/** 按域名 / 路径识别 Webhook 方言；无法识别时返回 generic。大小写不敏感。 */
export function detectWebhookDialect(url: string): WebhookDialect {
  const lowered = (typeof url === 'string' ? url : '').toLowerCase()
  for (const [dialect, prefixes] of DIALECT_PATTERNS) {
    if (prefixes.some((prefix) => lowered.includes(prefix))) return dialect
  }
  return 'generic'
}
