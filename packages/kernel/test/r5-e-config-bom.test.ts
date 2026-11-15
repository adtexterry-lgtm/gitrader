// SPDX-License-Identifier: CPAL-1.0
// R5 / GQ-59-A：BOM 报错看不见
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome, loadConfig, stripBom } from '../src/config'

const extra: string[] = []
afterEach(() => { for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('GQ-59-A BOM', () => {
  it('带 BOM 的合法配置能读；内容真坏的仍报错（正反双向）', () => {
    const home = mkdtempSync(join(tmpdir(), 'gr-bom-'))
    extra.push(home)
    const { paths, config } = initHome(home)
    writeFileSync(paths.config, '\uFEFF' + JSON.stringify(config, null, 2))
    expect(loadConfig(home).schema).toBe(config.schema)              // 修前抛 INVALID_REQUEST
    writeFileSync(paths.config, '\uFEFF{ "schema": ')                // BOM + 截断：仍然是坏的
    expect(() => loadConfig(home)).toThrowError(/cannot read/)
  })

  it('stripBom：能剥 BOM，无 BOM 的原样返回', () => {
    expect(stripBom('\uFEFFabc')).toBe('abc')
    expect(stripBom('abc')).toBe('abc')
  })
})
