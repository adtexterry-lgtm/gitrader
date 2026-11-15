// SPDX-License-Identifier: CPAL-1.0
// examples/workflows/*.json 是教学示例（无业绩含义），由测试夹具里的构造器生成；这里保证两边一致且都过校验。
// 重新生成：UPDATE_EXAMPLES=1 npx vitest run test/examples.test.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateWorkflow } from '../src/flow'
import { WORKFLOW_TEMPLATES } from './fixtures/workflow-templates'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'workflows')
// 最小均线示例只留在测试夹具里
const SHIPPED = WORKFLOW_TEMPLATES.filter((w) => w.meta?.strategyId !== 'ema-trend')

describe('examples/workflows', () => {
  for (const w of SHIPPED) {
    it(`${w.meta?.strategyId}：JSON 与构造器一致，且通过 gitrader-workflow/2 校验、可回测`, () => {
      const file = join(dir, `${w.meta!.strategyId}.json`)
      const json = JSON.stringify(w, null, 2) + '\n'
      if (process.env.UPDATE_EXAMPLES === '1') writeFileSync(file, json)
      expect(readFileSync(file, 'utf8')).toBe(json)
      const v = validateWorkflow(JSON.parse(json))
      expect(v.errors).toEqual([])
      expect(v.backtestable).toBe(true)
      expect(w.name).toMatch(/教学示例/)
    })
  }
})
