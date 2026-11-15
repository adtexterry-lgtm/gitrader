// SPDX-License-Identifier: CPAL-1.0
// 运行环境描述：与 docs/perf-baseline.md 的「硬件基线」一节同一组字段（CPU / 核数 / 平台 / Node），
// 不写主机名与用户名——报告要能公开贴出去而不带本机身份。

import { cpus, platform, release, arch } from 'node:os'

/** 当前进程的运行环境（纯读，不发网络请求、不读密钥）。 */
export function environmentInfo() {
  const list = cpus()
  return {
    node: process.version,
    platform: `${platform()} ${release()}`,
    arch: arch(),
    cpu: list[0]?.model ?? 'unknown',
    cores: list.length,
    generatedAt: new Date().toISOString(),
  }
}

/** 当前 RSS（MB，整数），报告里作为旁证而非指标。 */
export function rssMb() {
  return Math.round(process.memoryUsage().rss / 1048576)
}
