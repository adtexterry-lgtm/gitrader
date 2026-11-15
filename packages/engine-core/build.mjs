// SPDX-License-Identifier: CPAL-1.0
// 把引擎打成单文件 dist/engine-core.mjs（宿主以 `node dist/engine-core.mjs --stdio|--ws` 启动）。esbuild 打包，依赖全部内联。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

/** 同 buildEngine，另外返回 esbuild 的 metafile（发布包用它生成第三方声明）。 */
export async function buildEngineWithMeta(outfile = join(root, 'dist', 'engine-core.mjs')) {
  const result = await build({
    entryPoints: [join(root, 'src', 'bin.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    // ws 的可选原生加速模块：没装就走纯 JS，不打进包
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  })
  return { outfile, metafile: result.metafile }
}

export async function buildEngine(outfile = join(root, 'dist', 'engine-core.mjs')) {
  return (await buildEngineWithMeta(outfile)).outfile
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = await buildEngine()
  console.log(`built ${out}`)
}
