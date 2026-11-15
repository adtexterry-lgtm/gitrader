// SPDX-License-Identifier: CPAL-1.0
// 回测作业表落盘（GQ-12）：作业终态与结果写到 <artifactDir>/_jobs/<jobId>.json，引擎重启后仍能
// 答 status / result；起动时把悬空的 queued/running 清成 failed（进程死了就没人在算了）。
//
// 为什么是文件而不是 SQLite：引擎已经拿到 GITRADER_ENGINE_ARTIFACT_DIR（内核交给引擎
// <home>/lab/artifacts/<引擎id>），落在这里不引任何依赖。目录名 `_jobs` 前缀与内核的 `_stored` 同风格。
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BacktestResult, BacktestState, Problem } from '../proto'

export interface StoredJob {
  v: 1
  jobId: string
  state: BacktestState
  progress: number
  createdAt: number
  updatedAt: number
  error?: Problem
  result?: BacktestResult
}

const ID = /^job_[0-9A-Za-z]+$/                       // 文件名来自作业号：先校验再拼路径

export class JobStore {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }) }

  private file(id: string): string {
    if (!ID.test(id)) throw new Error('bad job id')
    return join(this.dir, `${id}.json`)
  }

  /** 原子写（临时文件 + rename）；写失败只丢这一次持久化，不影响作业。 */
  save(j: StoredJob): void {
    const f = this.file(j.jobId)
    const tmp = `${f}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(j))
      renameSync(tmp, f)
    } catch {
      try { rmSync(tmp, { force: true }) } catch { /* 清不掉就留着，下次覆盖 */ }
    }
  }

  remove(id: string): void {
    try { rmSync(this.file(id), { force: true }) } catch { /* ignore */ }
  }

  /** 读全部；坏文件 / 版本不对 / 文件名与内容里的 jobId 对不上 → 删掉并跳过。 */
  loadAll(): StoredJob[] {
    const out: StoredJob[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const j = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as StoredJob
        if (j.v !== 1 || `${j.jobId}.json` !== name) throw new Error('mismatch')
        out.push(j)
      } catch {
        try { rmSync(join(this.dir, name), { force: true }) } catch { /* ignore */ }
      }
    }
    return out
  }
}
