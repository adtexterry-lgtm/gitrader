// SPDX-License-Identifier: CPAL-1.0
// E0-10（应用半）：CLI 顶层失败分支的文案——内核 Problem 查中文表并给出下一步，普通错误只说「出错了」，
// 原文与堆栈只在 --debug / GITRADER_DEBUG=1 时出现；任何情形都不再打印 fatal:，也不把英文原文当主文案。
import { describe, expect, it } from 'vitest'
import { KernelError } from '@gitrader/kernel'
import { formatFatal } from '../src/fatal'

type Case = {
  title: string
  e: unknown
  /** 原始报错（debug 时必须出现）。 */
  raw: string
}

const kernelError = (name: string, message: string, retryAfterMs?: number): KernelError =>
  new KernelError({ code: 5003, name, category: 'AUTH', message, retryable: false, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } as never)

/** 服务端返回的 Problem（CLI 的 callOp 就是这么抛的）。 */
const opError = (name: string, message: string): Error => Object.assign(new Error(message), { problem: { code: 5003, name, category: 'AUTH', message, retryable: false } })

const CASES: Case[] = [
  { title: '错 PIN', e: kernelError('AUTH_FAILED', 'invalid PIN'), raw: 'invalid PIN' },
  { title: 'PIN 太短', e: kernelError('INVALID_PARAMS', 'PIN must be 6-12 digits'), raw: 'PIN must be 6-12 digits' },
  { title: 'PIN 锁定（带 retryAfterMs）', e: kernelError('AUTH_FAILED', 'too many failed PIN attempts', 90_000), raw: 'too many failed PIN attempts' },
  { title: '缺参数', e: kernelError('INVALID_PARAMS', 'missing params: out'), raw: 'missing params: out' },
  { title: '令牌被撤销', e: opError('AUTH_FAILED', 'the token has been revoked'), raw: 'the token has been revoked' },
  { title: 'PIN 未设置', e: kernelError('AUTH_FAILED', 'pin not set'), raw: 'pin not set' },
  { title: '安全文件损坏', e: kernelError('STATE_FILE_CORRUPT', 'keystore file is unreadable'), raw: 'keystore file is unreadable' },
  { title: '会话失效', e: opError('AUTH_FAILED', 'authentication required'), raw: 'authentication required' },
  { title: '内核连不上', e: new Error('fetch failed: connect ECONNREFUSED'), raw: 'fetch failed: connect ECONNREFUSED' },
  { title: '未知错误', e: 'boom', raw: 'boom' },
]

describe('formatFatal：顶层失败分支的人话文案', () => {
  it.each(CASES)('$title', (c) => {
    const out = formatFatal(c.e, { debug: false })
    expect(out.startsWith('出错了：')).toBe(true)
    expect(out).toMatch(/[一-龥]/)
    expect(out).not.toContain('fatal')
    expect(out).not.toContain('invalid')
    expect(out).not.toContain('presence proof')
    const debug = formatFatal(c.e, { debug: true })
    expect(debug).toContain(c.raw)
    expect(debug).toContain('原文：')
  })

  it('PIN 锁定把 retryAfterMs 说成秒数；有下一步时单独一行', () => {
    const out = formatFatal(kernelError('AUTH_FAILED', 'too many failed PIN attempts', 90_000), { debug: false })
    expect(out).toBe('出错了：PIN 试错次数过多，请 90 秒后再试\n下一步：等一会儿再试；忘了 PIN 可用 gitrader pin reset')
  })
})
