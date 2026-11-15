// SPDX-License-Identifier: CPAL-1.0
// 签名向量为手算值（HMAC-SHA256 + base64，钉钉再 URL 编码），算式写在常量上方；
// 与 QD webhook.py:123-137 的算法一致（QD 无测试向量，此处自建固定输入）。
import { describe, expect, it } from 'vitest'
import { signDingtalk, signFeishu } from '../src/index'

const FEISHU_SECRET = 'feishu-test-secret'
// key = "1700000000\nfeishu-test-secret"，message = "" → HMAC-SHA256 → base64
const FEISHU_SIGN_1700000000 = 'e3MJ8Q5llVxGJ8pVkGPBhexDAgjvYqpjPP1GkY9XceI='
// key = "1760000000\nfeishu-secret-2"，message = "" → HMAC-SHA256 → base64
const FEISHU_SECRET_2 = 'feishu-secret-2'
const FEISHU_SIGN_1760000000 = 'hWYeVnYKYpm2FU+kJy6FFn9SffD+WpmGnH39t7gILiM='

const DING_SECRET = 'SECdingtalktest'
// key = secret，message = "1700000000000\nSECdingtalktest" → HMAC-SHA256 → base64 → encodeURIComponent
const DING_SIGN_1700000000000 = 'JHmrURd46Kkp6pS8FyLjKUOx6g2z9LRclNTxxhiUoig%3D'
// key = "SECdingtalk2"，message = "1760000000123\nSECdingtalk2" → base64 = OSB+4fWKMeMKVaNjparTE2DXvhNDiCfoj1/bXGsD51Y=
const DING_SECRET_2 = 'SECdingtalk2'
const DING_SIGN_1760000000123 = 'OSB%2B4fWKMeMKVaNjparTE2DXvhNDiCfoj1%2FbXGsD51Y%3D'

describe('厂商签名', () => {
  it('飞书：key = `${ts}\n${secret}`，message 为空，base64 不 URL 编码', () => {
    expect(signFeishu(FEISHU_SECRET, 1700000000)).toBe(FEISHU_SIGN_1700000000)
    expect(signFeishu(FEISHU_SECRET_2, 1760000000)).toBe(FEISHU_SIGN_1760000000)
  })

  it('钉钉：key = secret，message = `${ts}\n${secret}`，base64 后 URL 编码', () => {
    expect(signDingtalk(DING_SECRET, 1700000000000)).toBe(DING_SIGN_1700000000000)
    expect(signDingtalk(DING_SECRET_2, 1760000000123)).toBe(DING_SIGN_1760000000123)
    // 编码后的 '+' '/' '=' 都成了百分号转义，可安全拼进查询串
    expect(decodeURIComponent(signDingtalk(DING_SECRET_2, 1760000000123))).toBe('OSB+4fWKMeMKVaNjparTE2DXvhNDiCfoj1/bXGsD51Y=')
  })

  it('签名的单位不同（秒 / 毫秒），且输出里不含密钥原文', () => {
    expect(signFeishu(FEISHU_SECRET, 1700000000)).not.toBe(signFeishu(FEISHU_SECRET, 1700000))
    expect(signDingtalk(DING_SECRET, 1700000000000)).not.toBe(signDingtalk(DING_SECRET, 1700000000))
    expect(signFeishu(FEISHU_SECRET, 1700000000)).not.toContain(FEISHU_SECRET)
    expect(signDingtalk(DING_SECRET, 1700000000000)).not.toContain(DING_SECRET)
  })
})
