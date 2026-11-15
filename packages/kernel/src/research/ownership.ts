// SPDX-License-Identifier: CPAL-1.0
// 研究作业归属跟踪（P2-5）：起作业时记录 jobId → sessionKey，status/result/cancel 校验归属。
// 内存存储，重启即清空。异步作业在引擎里跑，内核只记归属。
import { makeProblem } from '../proto'
import { KernelError } from '../util/errors'

export class ResearchJobOwnership {
  private readonly jobs = new Map<string, string>()

  recordJob(jobId: string, sessionKey: string): void {
    this.jobs.set(jobId, sessionKey)
  }

  assertJobOwner(jobId: string, sessionKey: string): void {
    const owner = this.jobs.get(jobId)
    if (owner === undefined || owner !== sessionKey) {
      throw new KernelError(makeProblem('INVALID_PARAMS', 'job not found or access denied'))
    }
  }
}
