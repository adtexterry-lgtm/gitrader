// SPDX-License-Identifier: Apache-2.0
// 卫生检查：产品文案禁词（附录 B）、不出现邮箱 / 非回环 IP、协议包不依赖其他 @gitrader 包、仓库两个许可证（本体 CPAL-1.0、接口包 Apache-2.0）、每个源文件带 SPDX 头。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PKG_ROOT } from './helpers'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// 禁词按片段拼接，避免测试文件自己命中自己（本文件在 test/ 下，也不在扫描范围）。
const BANNED = [['Com', 'fy'], ['Wallet', 'Connect'], ['保', '守'], ['激', '进'], ['稳', '赚'], ['跑', '赢']].map((p) => p.join(''))
const shipped = (): string[] =>
  ['src', 'schemas', 'scripts', 'conformance'].flatMap((d) => walk(join(PKG_ROOT, d))).concat(['README.md', 'CHANGELOG.md', 'OPEN-QUESTIONS.md', 'package.json'].map((f) => join(PKG_ROOT, f)))

describe('协议包卫生', () => {
  it('产品文案里没有禁用词（Comfy、WalletConnect、风险标签、承诺类词）', () => {
    for (const f of shipped()) {
      const text = readFileSync(f, 'utf8')
      for (const w of BANNED) expect(text.toLowerCase().includes(w.toLowerCase()), `${relative(PKG_ROOT, f)} contains a banned word`).toBe(false)
    }
  })
  it('没有邮箱，也没有非回环的 IPv4 地址', () => {
    for (const f of [...shipped(), ...walk(join(PKG_ROOT, 'test'))]) {
      const text = readFileSync(f, 'utf8')
      expect(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text), `${relative(PKG_ROOT, f)} looks like it contains an email`).toBe(false)
      const ips = (text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []).filter((ip) => ip !== '127.0.0.1' && ip !== '0.0.0.0')
      // 版本号形如 1.231.0 只有三段，不会命中四段 IP 模式
      expect(ips, `${relative(PKG_ROOT, f)} contains IP-like strings`).toEqual([])
    }
  })
  it('每个源文件第一行是 SPDX 许可标识（Apache-2.0）', () => {
    for (const f of ['src', 'scripts', 'conformance', 'examples'].flatMap(d => walk(join(PKG_ROOT, d)))) {
      if (!/\.(ts|mjs|py)$/.test(f)) continue
      const first = readFileSync(f, 'utf8').split(/\r?\n/, 1)[0] ?? ''
      expect(first, relative(PKG_ROOT, f)).toBe(`${f.endsWith('.py') ? '#' : '//'} SPDX-License-Identifier: Apache-2.0`)
    }
  })
  it('协议包不依赖其他 @gitrader 包（它是所有包的地基）', () => {
    const pj = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; license: string }
    expect(pj.license).toBe('Apache-2.0')
    for (const dep of Object.keys(pj.dependencies ?? {})) expect(dep.startsWith('@gitrader/'), dep).toBe(false)
  })
  it('两个许可证：产品本体 CPAL-1.0（根 LICENSE 是原文 + Exhibit B），三个接口包 Apache-2.0；各包 license 字段、LICENSE、README 首行与此一致，根文档里没有其他许可证的痕迹', () => {
    const root = join(PKG_ROOT, '..', '..')
    const apachePkgs = ['protocol', 'blocks-sdk', 'plugin-template']
    const license = readFileSync(join(root, 'LICENSE'), 'utf8')
    expect(license).toContain('Common Public Attribution License Version 1.0')
    expect(license).toContain('Attribution Phrase (not exceeding 10 words): Powered by Gitrader')
    expect(license).toContain('Display of Attribution Information is required in Larger Works')
    expect(license).not.toContain('Functional Source')
    const rootPj = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { license: string }
    expect(rootPj.license).toBe('CPAL-1.0')
    const apacheText = readFileSync(join(PKG_ROOT, 'LICENSE'), 'utf8')
    expect(apacheText).toContain('Apache License')
    expect(apacheText).toContain('Version 2.0, January 2004')
    for (const name of readdirSync(join(root, 'packages'))) {
      const dir = join(root, 'packages', name)
      const apache = apachePkgs.includes(name)
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { license: string }
      expect(pj.license, `${name}/package.json`).toBe(apache ? 'Apache-2.0' : 'CPAL-1.0')
      expect(readFileSync(join(dir, 'LICENSE'), 'utf8'), `${name}/LICENSE`).toBe(apache ? apacheText : license)
      expect(readFileSync(join(dir, 'README.md'), 'utf8').split('\n', 1)[0], `${name}/README.md first line`).toContain(apache ? 'Apache-2.0' : 'CPAL-1.0')
    }
    for (const f of ['README.md', 'CONTRIBUTING.md', 'NOTICE']) expect(/FSL|Functional Source|CLA/.test(readFileSync(join(root, f), 'utf8').replace('不需要签 CLA', '')), `${f} must not mention another licence`).toBe(false)
    expect(readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8')).toContain('Signed-off-by')
  })
  it('协议包源码不依赖 node 内置加密 / 文件系统模块（可进浏览器）', () => {
    for (const f of walk(join(PKG_ROOT, 'src'))) {
      const text = readFileSync(f, 'utf8')
      expect(/from 'node:(crypto|fs|path|child_process)'/.test(text), relative(PKG_ROOT, f)).toBe(false)
    }
  })
})
