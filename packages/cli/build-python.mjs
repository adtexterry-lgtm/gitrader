// SPDX-License-Identifier: CPAL-1.0
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function copyPythonEngine(sourceEngineDir, distDir) {
  const sourceDir = resolve(sourceEngineDir)
  const sourceFiles = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
    .map((entry) => entry.name)
    .sort()
  if (!sourceFiles.includes('main.py')) throw new Error('Python engine assets require main.py')
  if (!sourceFiles.includes('gep.py')) throw new Error('Python engine assets require gep.py')

  const targetDir = join(resolve(distDir), 'python-engine', 'engine')
  mkdirSync(targetDir, { recursive: true })
  for (const name of sourceFiles) copyFileSync(join(sourceDir, name), join(targetDir, name))
  return sourceFiles.map((name) => join(sourceDir, name))
}
