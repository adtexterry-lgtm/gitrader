// SPDX-License-Identifier: CPAL-1.0
// P0-4c：审批卡的附带止损一行（纯函数，不开浏览器）。pending.tsx 的浏览器断言留给维护者真浏览器验收。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { protectionLine } from '../../blocks-default/src/model-activity'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../src/views/pending.tsx'), 'utf8')

describe('P0-4c 审批卡：附带止损行', () => {
  it('pending view imports protectionLine and renders nothing without stop', () => {
    // 视图从模型里取 protectionLine，并按卡片算这一行
    expect(src).toContain('protectionLine')
    expect(src).toMatch(/import \{[^}]*protectionLine[^}]*\} from '\.\.\/\.\.\/\.\.\/blocks-default\/src\/model-activity'/)
    expect(src).toContain('protectionLine(card)')
    // 无止损 / 无止盈 → 不渲染（null）
    expect(protectionLine({})).toBeNull()
    expect(protectionLine({ maxLoss: '1.6' })).toBeNull()
    // 有止损才有一行，最大亏损只在给出估算时拼上
    expect(protectionLine({ stopLoss: '79437' })).toBe('附带止损 79,437')
    expect(protectionLine({ stopLoss: '79437', maxLoss: '1.604' })).toBe('附带止损 79,437 · 最多亏 ≈ 1.6')
  })
})
