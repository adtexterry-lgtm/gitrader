// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type CopyPythonEngine = (sourceEngineDir: string, distDir: string) => string[]
const engineSource = fileURLToPath(new URL('../../engine-python/engine/', import.meta.url))
const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build-python.mjs')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let tempRoot: string | undefined

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = undefined
})

function sourceFixture(skip?: string): { dir: string; files: string[] } {
  const dir = join(tempRoot!, 'source-engine')
  mkdirSync(dir, { recursive: true })
  const files = readdirSync(engineSource).filter((name) => name.endsWith('.py')).sort()
  for (const name of files) if (name !== skip) copyFileSync(join(engineSource, name), join(dir, name))
  return { dir, files: files.filter((name) => name !== skip) }
}

async function loadCopyHelper(): Promise<CopyPythonEngine> {
  const imported = await import(pathToFileURL(helperPath).href) as { copyPythonEngine?: CopyPythonEngine }
  if (typeof imported.copyPythonEngine !== 'function') throw new Error('copyPythonEngine export missing')
  return imported.copyPythonEngine
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('B2-09B Python asset copy helper', () => {
  it('copies exactly the nine real Python sources, preserves bytes, and ignores unrelated/cache content', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'gitrader-b2-09b-'))
    const source = sourceFixture()
    expect(source.files).toHaveLength(9)
    writeFileSync(join(source.dir, 'notes.txt'), 'ignored')
    mkdirSync(join(source.dir, '__pycache__'), { recursive: true })
    writeFileSync(join(source.dir, '__pycache__', 'nested.py'), 'ignored')
    writeFileSync(join(source.dir, 'ignored.pyc'), 'ignored')
    const dist = join(tempRoot, 'isolated', 'cli', 'dist')
    const copiedFrom = await (await loadCopyHelper())(source.dir, dist)
    const target = join(dist, 'python-engine', 'engine')
    expect(readdirSync(target).sort()).toEqual(source.files)
    expect(copiedFrom).toEqual(source.files.map((name) => join(source.dir, name)))
    for (const name of source.files) expect(sha256(join(target, name))).toBe(sha256(join(source.dir, name)))
  })

  it.each([
    ['main.py', 'Python engine assets require main.py'],
    ['gep.py', 'Python engine assets require gep.py'],
  ])('rejects an incomplete source missing %s without creating the asset target', async (missing, message) => {
    tempRoot = mkdtempSync(join(tmpdir(), 'gitrader-b2-09b-'))
    const source = sourceFixture(missing)
    const dist = join(tempRoot, 'isolated', 'cli', 'dist')
    await expect((async () => (await loadCopyHelper())(source.dir, dist))()).rejects.toThrow(message)
    expect(existsSync(join(dist, 'python-engine', 'engine'))).toBe(false)
  })

  it('bundled resolver selects only the isolated copied entry and fails when it is removed', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'gitrader-b2-09b-resolver-'))
    const dist = join(tempRoot, 'isolated', 'cli', 'dist')
    const copyPythonEngine = await loadCopyHelper()
    copyPythonEngine(engineSource, dist)
    const bundledEngines = join(dist, 'kernel-engines.mjs')
    await build({
      absWorkingDir: repoRoot,
      entryPoints: [join(repoRoot, 'packages', 'kernel', 'src', 'engines.ts')],
      outfile: bundledEngines,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: { js: "import { createRequire as __gtCreateRequire } from 'node:module'; const require = __gtCreateRequire(import.meta.url);" },
      logLevel: 'silent',
    })
    const imported = await import(`${pathToFileURL(bundledEngines).href}?isolated=${Date.now()}`) as {
      builtinEngineLaunch: (id: string, env?: Record<string, string | undefined>) => { command?: string; args?: string[] } | undefined
    }
    const expectedEntry = join(dist, 'python-engine', 'engine', 'main.py')
    const launch = imported.builtinEngineLaunch('python-engine', { GEP_PYTHON: 'python-test-command' })
    expect(launch?.command).toBe('python-test-command')
    expect(launch?.args).toEqual([expectedEntry])
    rmSync(expectedEntry)
    expect(imported.builtinEngineLaunch('python-engine', { GEP_PYTHON: 'python-test-command' })).toBeUndefined()
  })
})
