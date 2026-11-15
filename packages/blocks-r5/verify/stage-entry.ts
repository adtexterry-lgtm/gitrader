// SPDX-License-Identifier: CPAL-1.0
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeKernel } from '@gitrader/blocks-sdk/testing'
import { installViewFixtures } from '@gitrader/blocks-sdk/testing'
import { installScenario } from '../../blocks-default/fixtures/install'
import { startFixtureKernel } from '../../workbench/verify/fixture-kernel'
import { r5Fixtures } from '../fixtures/index'

const pages = ['lab-detail', 'overview', 'chart', 'records', 'funds', 'plugins', 'strategies', 'lab', 'venues', 'notify'] as const
const states = ['normal', 'empty', 'loading', 'error', 'offline', 'unwired'] as const
type ViewFixtureScenario = Parameters<typeof installViewFixtures>[1]
type Page = typeof pages[number]
type State = typeof states[number]

export interface StageScenario { page: Page; state: State; view?: string }
export interface StartStageOptions { staticDir: string; workspacesDir: string; scenario?: string }

const viewScenario: Record<State, ViewFixtureScenario> = {
  normal: 'normal', empty: 'empty', loading: 'normal', error: 'ok-false', offline: 'venue-unavailable', unwired: 'method-missing',
}
const viewMethods = new Set(['account.assets', 'account.equity_history', 'records.query', 'engine.strategies', 'engine.catalog', 'portfolio.analysis', 'lab.list', 'lab.get', 'lab.run', 'config.view'])
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function parseScenario(scenario = 'overview-normal'): StageScenario {
  const page = pages.find((candidate) => scenario.startsWith(`${candidate}-`))
  if (!page) throw new Error('Unknown stage page')
  const state = scenario.slice(page.length + 1) as State
  if (!states.includes(state)) throw new Error('Unknown stage state')
  return {
    page,
    state,
    ...(page === 'lab' ? { view: 'list' } : page === 'lab-detail' ? { view: 'detail' } : {}),
  }
}

export async function startStage(options: StartStageOptions) {
  const scenario = parseScenario(options.scenario)
  const workspacesDir = options.workspacesDir
  const pluginsDir = join(workspacesDir, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
  let kernel: Awaited<ReturnType<typeof startFixtureKernel>> | undefined
  try {
    kernel = await startFixtureKernel({
      staticDir: options.staticDir,
      workspacesDir,
      pluginsDir,
      injectAlways: true,
    })
    const stage = installScenario(kernel, scenario.state === 'empty' ? 'empty' : 'normal')
    if (scenario.state === 'loading') {
      const original = kernel.onQuery.bind(kernel)
      kernel.onQuery = ((method: string, fn: (params: unknown) => unknown) => original(method, async (params) => {
        if (viewMethods.has(method)) await wait(2_000)
        return fn(params)
      })) as FakeKernel['onQuery']
    }
    installViewFixtures(kernel, viewScenario[scenario.state])
    const registered = r5Fixtures[scenario.page] as Record<string, { queries?: Record<string, unknown>; commands?: Record<string, unknown>; view?: string }>
    const fixture = registered[scenario.state] ?? {}
    // 查询夹具的值可以是函数：按请求参数调用并返回（同一方法按参数答不同数，例如按账户分开的资金查询）。
    if (fixture.queries) for (const [method, value] of Object.entries(fixture.queries)) kernel.onQuery(method, (params) => typeof value === 'function' ? value(params) : value)
    if (fixture.commands) for (const [action, value] of Object.entries(fixture.commands)) kernel.onCommand(action, () => value)
    const r5 = { ...scenario, view: fixture.view ?? scenario.view }
    return { kernel, stage, r5 }
  } catch (error) {
    await kernel?.close()
    throw error
  }
}
