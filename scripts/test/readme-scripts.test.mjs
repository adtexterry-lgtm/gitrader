// SPDX-License-Identifier: CPAL-1.0
// 安装文档与根 package.json 脚本不脱节：README 里写的 npm run 命令必须真的存在。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

it('package.json 有 pack:release / pack:portable，且指向存在的脚本', () => {
  expect(pkg.scripts['pack:release']).toBe('node scripts/release/build-release-assets.mjs')
  expect(pkg.scripts['pack:portable']).toBe('node tools/portable/build-portable.mjs')
  for (const key of ['pack:release', 'pack:portable']) {
    const file = pkg.scripts[key].replace(/^node /, '')
    expect(() => readFileSync(join(repo, file), 'utf8'), file).not.toThrow()
  }
})

// 规格变更（Owner 批准）：README 改为面向 GitHub 首页的英文 README.md + 中文 README.zh-CN.md。
// 不再要求写 pack 命令和「npm 尚未发布」；改为：两份 README 里出现的每条 `npm run <脚本>` 都必须存在，且都给出安装命令。
it('两份 README 里的每条 npm run 都在 package.json scripts 里，且都给出 gitrader 安装命令', () => {
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const text = readFileSync(join(repo, name), 'utf8')
    for (const m of text.matchAll(/npm run ([w:.-]+)/g)) expect(pkg.scripts[m[1]], `${name}: npm run ${m[1]}`).toBeTruthy()
    expect(text, `${name} 安装命令`).toMatch(/npx gitrader|npm i(?:nstall)? -g gitrader/)
  }
})
