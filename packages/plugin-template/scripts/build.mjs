// SPDX-License-Identifier: Apache-2.0
// 打包示例插件：src/block.ts → example/ema-reading/block.js（单文件 ESM，无外链），然后给 example/ 下每个示例钉版本：把插件目录的内容哈希写回清单 source.sha256。
// 哈希算法见 scripts/pin.mjs（与内核加载插件时校验的是同一个算法，单测对拍）；自己写插件、没有这个仓库时用命令行：gitrader plugins pin <插件目录>。
//   node scripts/build.mjs
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { pinExamples } from './pin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '../example/ema-reading')
await build({
  entryPoints: [resolve(here, '../src/block.ts')],
  outfile: resolve(dir, 'block.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
})
for (const r of pinExamples(resolve(here, '../example'))) console.log(`pinned ${r.files} files → ${r.sha256}  ${r.dir}`)
