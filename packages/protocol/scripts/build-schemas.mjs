// SPDX-License-Identifier: Apache-2.0
// 由 scripts/schemas-*.mjs 生成 schemas/*.json（workflow.json 是契约 §5.9 原文，手工维护，不在此生成）。
//   node scripts/build-schemas.mjs          写入 schemas/
//   node scripts/build-schemas.mjs --check  只比对，有差异则退出码 1（测试用）
import { build } from 'esbuild'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, LAYER_COMMENT, NS, SINGLE, idOf } from './lib.mjs'
import { modelSchemas } from './schemas-model.mjs'
import { agentSchemas } from './schemas-agent.mjs'
import { gepSchemas } from './schemas-gep.mjs'
import { miscSchemas } from './schemas-misc.mjs'
import { uiSchemas } from './schemas-ui.mjs'
import { riskGateSchemas } from './schemas-risk-gate.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 把 src/constants.ts 打成内存里的 ESM 并加载，取得枚举常量。 */
export async function loadConstants() {
  const res = await build({
    absWorkingDir: root, entryPoints: ['src/constants.ts'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  })
  const text = res.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
}

export async function generateSchemas() {
  const K = await loadConstants()
  const entries = [
    ...Object.values(modelSchemas(K)),
    ...Object.values(agentSchemas(K)),
    ...Object.values(gepSchemas(K)),
    ...Object.values(miscSchemas(K)),
    ...Object.values(uiSchemas(K)),
    ...Object.values(riskGateSchemas(K)),
  ]
  const files = new Map()
  for (const e of entries) {
    const version = NS[e.domain].split(':')[1]
    const fileName = SINGLE.has(e.domain) ? `${e.domain}.json` : `${e.domain}.${e.name}.json`
    if (files.has(fileName)) throw new Error(`duplicate schema file ${fileName}`)
    const doc = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: idOf(e.domain, e.name),
      $comment: LAYER_COMMENT(e.domain, version),
      title: e.title,
      ...e.schema,
    }
    files.set(fileName, `${JSON.stringify(doc, null, 2)}\n`)
  }
  return files
}

/** 生成 src/schema-registry.ts：静态 import 全部 schemas/*.json（含手工维护的 workflow.json），供校验器与打包使用。 */
export function renderRegistry(fileNames) {
  const names = [...fileNames].sort()
  const lines = ['// SPDX-License-Identifier: Apache-2.0', '// 由 scripts/build-schemas.mjs 生成，勿手改。', '']
  names.forEach((f, k) => lines.push(`import s${k} from '../schemas/${f}'`))
  lines.push('', 'export const ALL_SCHEMAS: readonly Record<string, unknown>[] = [')
  names.forEach((_, k) => lines.push(`  s${k},`))
  lines.push(']', '')
  return lines.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check')
  const files = await generateSchemas()
  const dir = join(root, 'schemas')
  mkdirSync(dir, { recursive: true })
  let diff = 0
  const write = (p, text, label) => {
    if (check) {
      if (!existsSync(p) || readFileSync(p, 'utf8') !== text) { console.error(`out of date: ${label}`); diff += 1 }
    } else writeFileSync(p, text)
  }
  for (const [name, text] of files) write(join(dir, name), text, `schemas/${name}`)
  const all = new Set([...files.keys(), ...readdirSync(dir).filter((f) => f.endsWith('.json'))])
  write(join(root, 'src', 'schema-registry.ts'), renderRegistry(all), 'src/schema-registry.ts')
  if (check) process.exit(diff ? 1 : 0)
  console.log(`wrote ${files.size} schemas (+ registry of ${all.size}) to ${dir} (base ${BASE})`)
}
