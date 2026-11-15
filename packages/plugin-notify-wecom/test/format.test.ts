// SPDX-License-Identifier: CPAL-1.0
// L5-14 回归 + L5-12 parity：企业微信 markdown 的正文结构字符处理。
// 插件 format.mjs 是库 src/format.ts 的副本，两边输出必须逐字节一致。
import { describe, expect, it } from 'vitest'
import {
  escapeMarkdownStructure as libEscape,
  renderNoticeMarkdown as libRender,
} from '../../notify-wecom/src/format'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { escapeMarkdownStructure as pluginEscape, renderNoticeMarkdown as pluginRender } from '../format.mjs'

const INJECTIONS = [
  '[点我领空投](https://evil.example)',
  '[x](https://evil.example) [y](https://evil.example)',
  '<font color="warning">注意</font>',
  '<a href="https://evil.example">点我</a>',
  '# 假标题',
  '### 二级假标题',
  'plain text',
  'issue #12 不是标题',
  '',
]

describe('escapeMarkdownStructure：结构字符换成全角，链接不再成链', () => {
  it('方括号 / 圆括号 / 尖括号全部中和', () => {
    expect(pluginEscape('[点我领空投](https://evil.example)')).toBe('［点我领空投］（https://evil.example）')
    expect(pluginEscape('<font color="warning">注意</font>')).toBe('＜font color="warning">注意＜/font>')
  })

  it('行首 # 变全角，行中 # 不动', () => {
    expect(pluginEscape('# 假标题')).toBe('＃ 假标题')
    expect(pluginEscape('### 假标题')).toBe('＃＃＃ 假标题')
    expect(pluginEscape('issue #12 不是标题')).toBe('issue #12 不是标题')
  })

  it('同一批输入两边逐字节一致（parity）', () => {
    for (const input of INJECTIONS) expect(pluginEscape(input)).toBe(libEscape(input))
  })
})

describe('renderNoticeMarkdown：模板前缀保留，正文注入被中和', () => {
  const notice = {
    title: 'Risk denial [x](https://evil.example)',
    lines: ['[点我领空投](https://evil.example)', '<font color="warning">注意</font>'],
    level: 'warn' as const,
    ts: 1760000000000,
  }

  it('正文里不再出现可成链的 `](` 与可用的 `<font>`', () => {
    const rendered = pluginRender(notice)
    expect(rendered).not.toContain('](')
    expect(rendered).not.toContain('<font')
    expect(rendered).toContain('［点我领空投］（https://evil.example）')
    // 插件自己生成的模板前缀 `### [WARN]` 仍是半角（否则微信认不出标题）
    expect(rendered.split('\n')[0]).toMatch(/^### \[WARN\] /)
  })

  it('与库输出逐字节一致（parity）', () => {
    expect(pluginRender(notice)).toBe(libRender(notice))
    expect(pluginRender({ title: 't', lines: ['# 假标题'] })).toBe(libRender({ title: 't', lines: ['# 假标题'] }))
  })
})
