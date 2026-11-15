// SPDX-License-Identifier: CPAL-1.0
// 研究作业的计算提供者（第六轮 C 包）：engine-core 经 EngineCoreOptions.research 注入，launcher 装配。
// 计算放在工作线程里（寻优一次几十秒，不能堵住引擎主线程的心跳与 GEP 应答）；没有 workerUrl（非打包运行 / 单测）时同线程异步跑。
import { Worker } from 'node:worker_threads'
import { getStrategySource } from '@gitrader/engine-core'
import type { ResearchComputeHandle, ResearchComputeHooks, ResearchComputeInput, ResearchOutcome, ResearchProvider } from '@gitrader/engine-core'
import { checkOptimizePlan, computeFactors, computeOptimize } from './research-compute'
import type { WireRequest, WorkerMessage } from './research-compute'

function wireOf(input: ResearchComputeInput): WireRequest {
  if (input.kind === 'factor_report') return input
  const { def, params } = input.strategy
  const source = getStrategySource(def)
  return {
    ...input,
    strategy: {
      meta: { id: def.id, name: def.name, ...(def.nameZh ? { nameZh: def.nameZh } : {}), version: def.version, desc: def.desc, tags: def.tags, params: def.params, defaults: def.defaults, ...(def.file ? { file: def.file } : {}) },
      ...(source !== undefined ? { source } : { builtinId: def.id }),
      hasAnchor: typeof def.anchor === 'function',
      params,
    },
  }
}

export function createResearchProvider(o: { workerUrl?: URL } = {}): ResearchProvider {
  return {
    checkOptimize: (plan) => checkOptimizePlan(plan),
    compute(input: ResearchComputeInput, hooks: ResearchComputeHooks): ResearchComputeHandle {
      if (!o.workerUrl) {
        let cancelled = false
        const done = new Promise<ResearchOutcome>((resolve, reject) => {
          setImmediate(() => {
            if (cancelled) return reject(new Error('cancelled'))
            try {
              resolve(input.kind === 'factor_report' ? computeFactors(input, hooks) : computeOptimize({ ...input, def: input.strategy.def, fixed: input.strategy.params }, hooks))
            } catch (e) { reject(e) }
          })
        })
        return { done, cancel: () => { cancelled = true } }
      }
      const w = new Worker(o.workerUrl, { workerData: { gitraderRole: 'research', request: wireOf(input) } })
      const done = new Promise<ResearchOutcome>((resolve, reject) => {
        w.on('message', (m: WorkerMessage) => {
          if (m.t === 'progress') hooks.progress(m.done, m.total)
          else if (m.t === 'done') { resolve(m.outcome); void w.terminate() }
          else { reject(new Error(m.message)); void w.terminate() }
        })
        w.once('error', (e) => reject(new Error(`research worker crashed: ${e.message}`)))
        w.once('exit', (code) => reject(new Error(`research worker exited (${code}) before finishing`)))
      })
      return { done, cancel: () => { void w.terminate() } }
    },
  }
}
