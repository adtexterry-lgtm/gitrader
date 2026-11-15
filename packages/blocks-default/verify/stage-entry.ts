// SPDX-License-Identifier: CPAL-1.0
// 无头验证的舞台：壳的夹具内核（F）+ 本包场景（fixtures/install.ts）。由 verify/stage.mjs 用 esbuild 打成临时 mjs 后加载。
import { startFixtureKernel } from '../../workbench/verify/fixture-kernel'
import { installScenario, type Stage } from '../fixtures/install'
import type { ScenarioName } from '../fixtures/scenarios'

export async function startStage(o: { staticDir: string; workspacesDir: string; scenario: ScenarioName }) {
  const kernel = await startFixtureKernel({ staticDir: o.staticDir, workspacesDir: o.workspacesDir, injectAlways: true /* H v2：夹具内核改成默认只认 ?launch，块的渲染测试每次直接打开页面 */ })
  const stage: Stage = installScenario(kernel, o.scenario)
  return { kernel, stage }
}
