// SPDX-License-Identifier: CPAL-1.0
// 包卫生：每个源文件带 SPDX 头；源码与说明里不出现任何模型供应商名字（模型只经 `Llm` 抽象进来）；
// package.json 只依赖工作区包、许可证 CPAL-1.0、README 首行写明许可证。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPromiseLanguage } from '../../protocol/src/plugin/manifest'

const PKG = join(import.meta.dirname, '..')

/** 厂商名按片段拼接：本文件自己不该被扫成「出现了厂商名」。 */
const VENDORS = [
  'open' + 'ai', 'anthro' + 'pic', 'cla' + 'ude', 'chat' + 'gpt', '\\bgpt\\b', 'gem' + 'ini',
  'deep' + 'seek', 'q' + 'wen', 'lla' + 'ma', 'mist' + 'ral', 'open' + 'router', 'moon' + 'shot',
  'ki' + 'mi', 'zhi' + 'pu', 'cohere', 'grok', 'oll' + 'ama',
].map((v) => new RegExp(v, 'i'))

const sources = readdirSync(join(PKG, 'src')).filter((f) => f.endsWith('.ts')).map((f) => join(PKG, 'src', f))

describe('strategy-ai 包卫生', () => {
  it('每个源文件第一行是 SPDX 头', () => {
    expect(sources.length).toBeGreaterThan(5)
    for (const f of sources) {
      expect(readFileSync(f, 'utf8').split(/\r?\n/, 1)[0]).toBe('// SPDX-License-Identifier: CPAL-1.0')
    }
  })

  it('源码与 README 里不出现任何模型供应商名字（只用 llm 抽象）', () => {
    for (const f of [...sources, join(PKG, 'README.md')]) {
      const text = readFileSync(f, 'utf8')
      for (const re of VENDORS) expect(re.test(text), `${f} mentions ${re.source}`).toBe(false)
    }
  })

  it('package.json：CPAL-1.0、只依赖工作区包、入口是 src/index.ts', () => {
    const pj = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      license: string
      exports: Record<string, string>
      dependencies: Record<string, string>
    }
    expect(pj.license).toBe('CPAL-1.0')
    expect(pj.exports['.']).toBe('./src/index.ts')
    for (const dep of Object.keys(pj.dependencies)) expect(dep.startsWith('@gitrader/')).toBe(true)
  })

  it('不读环境变量、源码里没有 key / secret / token 字样（凭据只在注入的 client 里）', () => {
    for (const f of sources) {
      const text = readFileSync(f, 'utf8')
      expect(/process\s*\.\s*env/.test(text), f).toBe(false)
      expect(/api[_-]?key|secret|token|bearer/i.test(text), f).toBe(false)
    }
  })

  it('README 首行写明许可证，且零承诺语言', () => {
    const readme = readFileSync(join(PKG, 'README.md'), 'utf8')
    expect(readme.split('\n', 1)[0]).toContain('CPAL-1.0')
    expect(findPromiseLanguage(readme)).toBeNull()
  })
})
