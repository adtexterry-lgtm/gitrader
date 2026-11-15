// SPDX-License-Identifier: CPAL-1.0
// L5-14 回归 + L5-12 parity：飞书 / 企业微信 markdown 形态的正文结构字符处理。
// 通知正文可能带外部数据源字符串（标的名称、交易所错误文本），`[点我](https://evil)` 不能变成可点击链接。
import { describe, expect, it } from 'vitest'
import { escapeMarkdownStructure as libEscape } from '../../notify-webhook/src/markdown'
import { escapeMarkdownStructure as pluginEscape, renderNotice as pluginRender } from '../webhook.mjs'
import { notifySend } from '../index.mjs'

interface Call { url: string; init: Record<string, unknown> }

function recorder(): { calls: Call[]; fetch: (url: string, init: Record<string, unknown>) => Promise<{ status: number; text: () => Promise<string> }> } {
  const calls: Call[] = []
  const fetch = async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init })
    return { status: 200, text: async () => '{"code":0}' }
  }
  return { calls, fetch }
}

const INJECTED = {
  key: 'risk.denials:acct_x:ruleY',
  level: 'warn' as const,
  title: 'Risk denial',
  lines: ['[点我领空投](https://evil.example)', '<font color="warning">注意</font>', 'notional 1200 > 1000'],
  ts: 1760000000000,
}

const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>

describe('escapeMarkdownStructure', () => {
  it('链接 / 标签 / 行首标题被中和，比较符与正文保持原样', () => {
    expect(pluginEscape('[点我](https://evil.example)')).toBe('［点我］（https://evil.example）')
    expect(pluginEscape('<font color="red">x</font>')).toBe('＜font color="red">x＜/font>')
    expect(pluginEscape('### 假标题')).toBe('＃＃＃ 假标题')
    expect(pluginEscape('notional 1200 > 1000')).toBe('notional 1200 > 1000')
    expect(pluginEscape('issue #12 不是标题')).toBe('issue #12 不是标题')
  })

  it('与库 notify-webhook/src/markdown.ts 逐字节一致（parity）', () => {
    for (const input of [
      '',
      '[x](https://e.x)',
      '<a href="https://e.x">点我</a>',
      '# 标题',
      '> 引用',
      '1200 > 1000',
      'a < b',
      'plain',
    ]) {
      expect(pluginEscape(input), input).toBe(libEscape(input))
    }
  })
})

describe('renderNotice：只有飞书 / 企微的富文本形态做转义', () => {
  it('wecom / feishu 的 markdown 输出不含可成链的 `](`，模板前缀仍是 `### `', () => {
    for (const dialect of ['wecom', 'feishu']) {
      const text = pluginRender(INJECTED, true, dialect)
      expect(text, dialect).not.toContain('](')
      expect(text, dialect).not.toContain('<font')
      expect(text.split('\n')[0], dialect).toBe('### Risk denial')
    }
  })

  it('discord / slack / generic 与纯文本形态保持原样', () => {
    for (const dialect of ['discord', 'slack', 'generic', undefined]) {
      expect(pluginRender(INJECTED, true, dialect), String(dialect)).toContain('[点我领空投](https://evil.example)')
    }
    expect(pluginRender(INJECTED, false, 'wecom')).toContain('[点我领空投](https://evil.example)')
  })
})

describe('notifySend：企业微信 / 飞书 markdown 请求体里正文已中和', () => {
  it('企微 markdown body 的 content 不再含 `](` 与 `<font`', async () => {
    const fake = recorder()
    await notifySend(
      { notice: INJECTED, params: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', markdown: true } },
      { fetch: fake.fetch, env: {} },
    )
    const content = (bodyOf(fake.calls[0]!).markdown as { content: string }).content
    expect(content).not.toContain('](')
    expect(content).not.toContain('<font')
    expect(content).toContain('［点我领空投］（https://evil.example）')
  })

  it('飞书 lark_md 的 content 同样已中和', async () => {
    const fake = recorder()
    await notifySend(
      { notice: INJECTED, params: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', markdown: true } },
      { fetch: fake.fetch, env: {} },
    )
    const elements = (bodyOf(fake.calls[0]!).card as { elements: Array<{ text: { content: string } }> }).elements
    const content = elements[0]!.text.content
    expect(content).not.toContain('](')
    expect(content).toContain('［点我领空投］')
  })

  it('纯文本形态不动正文（转义只针对富文本方言）', async () => {
    const fake = recorder()
    await notifySend(
      { notice: INJECTED, params: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } },
      { fetch: fake.fetch, env: {} },
    )
    const text = (bodyOf(fake.calls[0]!).text as { content: string }).content
    expect(text).toContain('[点我领空投](https://evil.example)')
  })
})
