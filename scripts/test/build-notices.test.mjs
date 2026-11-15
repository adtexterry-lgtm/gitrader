// SPDX-License-Identifier: CPAL-1.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { afterEach } from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const testDir = dirname(fileURLToPath(import.meta.url))
const fixtureRoots = []
const actualQdSource = join(repo, 'packages/connector-binance-trade/src/precision.ts')
const actualNoticesSource = join(repo, 'THIRD_PARTY_NOTICES.md')
const qdSourceText = readFileSync(actualNoticesSource, 'utf8')
const qdSection = qdSourceText.slice(qdSourceText.indexOf('## QuantDinger')).trim()

function fixture({ qd = false, notices = true, noticeText = qdSourceText } = {}) {
  const root = mkdtempSync(join(testDir, '.b4a-fixture-'))
  fixtureRoots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'packages/demo/src'), { recursive: true })
  mkdirSync(join(root, 'packages/demo/dist'), { recursive: true })
  const buildScript = readFileSync(join(repo, 'scripts/build.mjs'), 'utf8')
  const resolvedEsbuild = createRequire(import.meta.url).resolve('esbuild')
  writeFileSync(join(root, 'scripts/build.mjs'), buildScript.replace(
    "import { build } from 'esbuild'",
    `import { createRequire } from 'node:module'\nconst { build } = createRequire(import.meta.url)(${JSON.stringify(resolvedEsbuild)})`,
  ))
  copyFileSync(join(repo, 'scripts/gen-notices.mjs'), join(root, 'scripts/gen-notices.mjs'))
  if (notices) writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), noticeText)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gitrader-test-fixture', private: true, type: 'module' }))
  writeFileSync(join(root, 'packages/demo/package.json'), JSON.stringify({
    name: 'gitrader-test-demo', version: '1.0.0', type: 'module',
    gitrader: { build: { entry: './src/index.ts', outfile: 'dist/index.js', platform: 'node', format: 'esm', external: ['@gitrader/protocol', '@gitrader/protocol/*'] } },
  }))
  if (qd) copyFileSync(actualQdSource, join(root, 'packages/demo/src/index.ts'))
  else writeFileSync(join(root, 'packages/demo/src/index.ts'), 'export const fixtureValue = 1\n')
  return root
}

afterEach(() => {
  const allowedParent = resolve(testDir) + sep
  for (const root of fixtureRoots.splice(0)) {
    const resolvedRoot = resolve(root)
    if (!resolvedRoot.startsWith(allowedParent) || !resolvedRoot.split(sep).at(-1).startsWith('.b4a-fixture-')) {
      throw new Error('Refusing to remove a fixture outside the owned scripts/test temporary directory')
    }
    rmSync(resolvedRoot, { recursive: true, force: true })
  }
})

function build(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts/build.mjs'), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  })
}

test('build writes the original QD notice section beside a bundle containing QD-derived source', () => {
  const root = fixture({ qd: true })
  const result = build(root)
  assert.equal(result.status, 0, `the fixture build should succeed: ${result.stderr}`)
  const output = readFileSync(join(root, 'packages/demo/dist/THIRD-PARTY-NOTICES.md'), 'utf8')
  assert.ok(output.includes(qdSection), 'the package notice should preserve the source QD attribution section')
  assert.match(output, /QuantDinger/)
  assert.match(output, /v5\.6\.5/)
  assert.match(output, /Apache License 2\.0/)
  assert.match(output, /Changes:/)
})

test('build does not assign QD attribution when no included source has the marker', () => {
  const root = fixture()
  const result = build(root)
  assert.equal(result.status, 0, `the fixture build should succeed: ${result.stderr}`)
  const output = readFileSync(join(root, 'packages/demo/dist/THIRD-PARTY-NOTICES.md'), 'utf8')
  assert.doesNotMatch(output, /QuantDinger/)
})

test('--notices appends the QD source section once and repeated builds remain idempotent', () => {
  const root = fixture({ qd: true })
  const first = build(root, ['--notices'])
  assert.equal(first.status, 0, `the summary build should succeed: ${first.stderr}`)
  const outputFile = join(root, 'THIRD-PARTY-NOTICES.md')
  const firstOutput = readFileSync(outputFile, 'utf8')
  assert.equal((firstOutput.match(/^## QuantDinger$/gm) ?? []).length, 1)
  const second = build(root, ['--notices'])
  assert.equal(second.status, 0, 'the repeated summary build should succeed')
  const secondOutput = readFileSync(outputFile, 'utf8')
  assert.equal((secondOutput.match(/^## QuantDinger$/gm) ?? []).length, 1)
  assert.equal(secondOutput, firstOutput)
})

test('build fails if QD source is included but the original attribution source is missing', () => {
  const root = fixture({ qd: true, notices: false })
  const result = build(root)
  assert.notEqual(result.status, 0, 'missing QD attribution must fail a QD-derived build')
})

test('build fails if QD source is included but the source notice has no QuantDinger section', () => {
  const root = fixture({ qd: true, noticeText: '# Other notices\n' })
  const result = build(root)
  assert.notEqual(result.status, 0, 'missing QD notice section must fail a QD-derived build')
  assert.match(result.stderr, /QuantDinger notice section is missing/)
})
