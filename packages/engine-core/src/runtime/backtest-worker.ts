// SPDX-License-Identifier: CPAL-1.0
// 回测工作线程：在独立线程里跑 computeBacktest，不阻塞主线程心跳（GQ-03）
import { parentPort, workerData } from 'node:worker_threads'
import type { Candle } from '../types'
import type { Params, StrategyDef } from '../strategy/types'
import type { Workflow } from '../flow/types'
import type { SimOptions } from '../strategy'
import { computeBacktest, type ComputeOutput } from './backtest-compute'

export type WireSubject =
  | { kind: 'strategy'; meta: Omit<StrategyDef, 'evaluate' | 'anchor'>; source: string; hasAnchor: boolean; params: Params }
  | { kind: 'workflow'; workflow: Workflow; instrumentId: string; interval: string }

export interface WorkerRequest {
  subject: WireSubject
  candles: Candle[]
  sim: SimOptions
  stepMs: number
}

export type WorkerMessage =
  | { t: 'stage'; stage: 'signals' | 'simulating'; fraction: number }
  | { t: 'done'; out: ComputeOutput }
  | { t: 'error'; message: string }

export function serveBacktestWorker(): void {
  const req = (workerData as { gitraderRole: string; request: WorkerRequest }).request
  void (async () => {
    try {
      let subject: Parameters<typeof computeBacktest>[0]['subject']
      if (req.subject.kind === 'workflow') {
        subject = req.subject
      } else {
        const mod = await import('data:text/javascript;base64,' + Buffer.from(req.subject.source, 'utf8').toString('base64'))
        const raw = (mod.default ?? mod.strategy) as { evaluate: StrategyDef['evaluate']; anchor?: StrategyDef['anchor'] }
        subject = {
          kind: 'strategy',
          params: req.subject.params,
          def: {
            ...req.subject.meta,
            evaluate: (c, p) => raw.evaluate(c, p),
            ...(req.subject.hasAnchor ? { anchor: (c: Candle[], p: Params) => raw.anchor!(c, p) } : {}),
          },
        }
      }
      let last = -1
      const out = await computeBacktest(
        { subject, candles: req.candles, sim: req.sim, stepMs: req.stepMs },
        {
          stage: (stage, fraction) => {
            const k = Math.floor(fraction * 100)
            if (k !== last) {
              last = k
              parentPort!.postMessage({ t: 'stage', stage, fraction } satisfies WorkerMessage)
            }
          },
          cancelled: () => false,
          yieldLoop: async () => undefined,
        }
      )
      if (out) {
        parentPort!.postMessage({ t: 'done', out } satisfies WorkerMessage)
      }
    } catch (e) {
      parentPort!.postMessage({ t: 'error', message: e instanceof Error ? e.message : String(e) } satisfies WorkerMessage)
    }
  })()
}
