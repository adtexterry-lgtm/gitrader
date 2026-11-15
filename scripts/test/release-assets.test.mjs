// SPDX-License-Identifier: CPAL-1.0
// 发布资产脚本的纯函数自检：tgz 清单规则、便携包内容判据、SHA256SUMS 文本。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { checkTgzManifest, portableHasRuntime, sha256sums } from '../release/build-release-assets.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

it('tgz has no runtime deps', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8'))
  expect(checkTgzManifest(pkg)).toEqual([])
  expect(checkTgzManifest({ ...pkg, dependencies: { '@gitrader/venue-paper': '0.1.0' } }).length).toBeGreaterThan(0)
  expect(checkTgzManifest({ ...pkg, dependencies: { 'some-third-party': '^1.2.3' } }).length).toBeGreaterThan(0)
})

it('portable zip contains runtime + start script', () => {
  const winFiles = [
    'runtime/node.exe',
    'app/cli/bin.js',
    'app/cli/workbench/index.html',
    'bin/gitrader.cmd',
    'start.cmd',
    'manifest.json',
  ]
  expect(portableHasRuntime(winFiles, 'win-x64')).toBe(true)
  expect(portableHasRuntime(['app/cli/bin.js', 'start.cmd'], 'win-x64')).toBe(false)
  expect(portableHasRuntime(['runtime/node', 'app/cli/bin.js', 'start.sh'], 'linux-x64')).toBe(true)
  expect(portableHasRuntime(['runtime/node', 'start.sh'], 'linux-x64')).toBe(false)
})

it('SHA256SUMS matches files', () => {
  const files = [
    { name: 'gitrader-portable.zip', bytes: Buffer.from('portable payload') },
    { name: 'gitrader.tgz', bytes: Buffer.from('tarball payload') },
  ]
  const text = sha256sums(files)
  const lines = text.trimEnd().split('\n')
  expect(lines).toHaveLength(files.length)
  expect(lines.map((line) => line.split(/\s+/)[1])).toEqual(['gitrader-portable.zip', 'gitrader.tgz'])
  for (const file of files) {
    const line = lines.find((l) => l.endsWith(`  ${file.name}`))
    expect(line).toBeDefined()
    expect(String(line).split(/\s+/)[0]).toBe(hex(file.bytes))
  }
})
