// SPDX-License-Identifier: CPAL-1.0
// 插件 index.mjs 与库 src/client.ts 各有一份出网目标判定（L5-02 修在两处）：
// 逐条比对「https / 明文 http 发往字面回环 / 其余明文 http / 非法」四分类，防止只改一边留下明文口子（L5-12）。
import { describe, expect, it } from 'vitest'
import { webhookUrlKind as libUrlKind } from '../../notify-webhook/src/client'
import { webhookUrlKind as pluginUrlKind } from '../index.mjs'

const HTTPS_URLS = [
  'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
  'https://oapi.dingtalk.com/robot/send?access_token=t',
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
  'https://hooks.slack.com/services/T/B/x',
  'https://discord.com/api/webhooks/1/x',
  'https://ntfy.internal/alerts',
]

/** 明文 http 里唯一放行的一类：发往字面回环主机（loopback 例外）。 */
const LOOPBACK_URLS = [
  'http://127.0.0.1:8787/hook',
  'http://localhost:8080/hook',
  'http://[::1]/x',
]

/** 除字面回环外的明文 http：私网、云元数据、外域、相似域名都不放行。 */
const INSECURE_URLS = [
  'http://collector.example.com/hook?token=x',
  'http://example.test/x',
  'http://169.254.169.254/latest/meta-data',
  'http://10.0.0.1/x',
  'http://127.0.0.1.example.test/x',
]

const URLS = [
  ...HTTPS_URLS,
  ...LOOPBACK_URLS,
  ...INSECURE_URLS,
  'ftp://example.com/x',
  'file:///etc/passwd',
  'not-a-url',
  '',
  '   ',
  'https://',
]

describe('index.mjs 与库 src/client.ts 的出网目标判定一致', () => {
  it('20 个夹具两边逐条相同', () => {
    expect(URLS).toHaveLength(20)
    for (const url of URLS) expect(pluginUrlKind(url), url).toBe(libUrlKind(url))
  })

  it('明文 http：字面回环主机放行（loopback 例外），其余一律 insecure', () => {
    for (const url of LOOPBACK_URLS) {
      expect(pluginUrlKind(url), url).toBe('loopback')
      expect(libUrlKind(url), url).toBe('loopback')
    }
    for (const url of INSECURE_URLS) {
      expect(pluginUrlKind(url), url).toBe('insecure')
      expect(libUrlKind(url), url).toBe('insecure')
    }
  })
})
