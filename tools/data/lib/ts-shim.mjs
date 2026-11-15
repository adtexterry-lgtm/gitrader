// SPDX-License-Identifier: CPAL-1.0
// 解析钩子：让普通 `node` 直接 import 本仓的 TS 工作区包（@gitrader/data-files / @gitrader/protocol /
// @gitrader/connector-<venue>-data），从而不必先构建 dist、也不引第三方运行器。
//
// 补三件 Node 原生不做的事（仓库按 tsc 的解析口径写源码）：
//   1. 无扩展名的相对导入 → 依次试 `<spec>.ts` / `<spec>/index.ts` / `<spec>.tsx` / `<spec>.js`
//      （Node 22 自带类型擦除，.ts 文件本身可以直接执行，只是要求显式扩展名）。
//   2. 无扩展名的裸导入（如 ajv 的 'ajv/dist/2020'）→ 试 `<spec>.js` / `<spec>/index.js`。
//   3. `.json` 导入补 `type: 'json'` 导入属性（protocol 的 schemas/*.json 用裸 import 写的）。
// 只动解析，不改源码、不做转译；不能被解析到的模块仍然按 Node 原生报错。
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.json')) {
    const resolved = await nextResolve(specifier, { ...context, importAttributes: { type: 'json' } })
    return { ...resolved, importAttributes: { type: 'json' } }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (e) {
    const code = e && e.code
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw e
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const base = new URL(specifier, context.parentURL)
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.tsx`, `${base.href}.js`]) {
        try {
          return await nextResolve(candidate, context)
        } catch {
          /* 下一个候选 */
        }
      }
    } else {
      for (const candidate of [`${specifier}.js`, `${specifier}/index.js`]) {
        try {
          return await nextResolve(candidate, context)
        } catch {
          /* 下一个候选 */
        }
      }
    }
    throw e
  }
}

/** 从任意 .mjs 里注册本钩子：`await registerTsShim()`。必须在 import TS 包之前调用。 */
export async function registerTsShim() {
  const { register } = await import('node:module')
  register(new URL('./ts-shim.mjs', import.meta.url).href)
}
