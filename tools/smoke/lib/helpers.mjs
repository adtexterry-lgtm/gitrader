// SPDX-License-Identifier: CPAL-1.0
// 纸面模式端到端冒烟的公共辅助件（journey.mjs 与 test/ 共用；不联网、不碰用户 ~/.gitrader）。
import { createServer } from 'node:net'

/**
 * 让操作系统分配一个空闲 TCP 端口（绑定 127.0.0.1:0 后立刻释放）。
 * 只用于给本次冒烟的子进程挑端口；真正的独占仍由内核 bind 决定（冲突会明确报错）。
 */
export function pickFreePort(o = {}) {
  const host = o.host ?? '127.0.0.1'
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => (Number.isInteger(port) && port > 0 ? resolve(port) : reject(new Error('no port assigned'))))
    })
  })
}

/**
 * 轮询就绪探针直到 200 或超时。永不抛错：超时返回 { ok:false, lastStatus, attempts, elapsedMs }。
 * fetchImpl / sleep 可注入（测试里不真起服务）。
 */
export async function waitForReady(url, o = {}) {
  const timeoutMs = o.timeoutMs ?? 60_000
  const intervalMs = o.intervalMs ?? 250
  const fetchImpl = o.fetchImpl ?? globalThis.fetch
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const token = o.token
  const started = Date.now()
  let attempts = 0
  let lastStatus = 0
  let lastBody = null
  for (;;) {
    attempts += 1
    try {
      const res = await fetchImpl(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(10_000, timeoutMs))),
      })
      lastStatus = res.status
      try { lastBody = await res.json() } catch { lastBody = null }
      if (res.status === 200) return { ok: true, lastStatus, attempts, elapsedMs: Date.now() - started, body: lastBody }
    } catch { /* 服务还没起来：继续轮询 */ }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, lastStatus, attempts, elapsedMs: Date.now() - started, body: lastBody }
    }
    await sleep(intervalMs)
  }
}

/**
 * 只结束「本次冒烟自己记录过」的子进程：丢弃当前进程、非正整数与重复项。
 * 调用方只用返回的 pid 列表去杀（绝不按名字 / 端口反查，避免误杀用户自己的 gitrader）。
 */
export function killTargets(records) {
  const own = new Set()
  for (const r of records ?? []) {
    const pid = typeof r === 'number' ? r : r?.pid
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (pid === process.pid) continue
    own.add(pid)
  }
  return [...own]
}

/** 步骤 / 耗时 / 结果表（纯文本，便于贴进报告）。 */
export function formatTable(rows, cols = ['#', 'step', 'ms', 'result', 'detail']) {
  const head = cols
  const body = rows.map((r, i) => cols.map((c) => (c === '#' ? String(i + 1) : String(r[c] ?? ''))))
  const all = [head, ...body]
  const width = head.map((_, i) => Math.max(...all.map((line) => [...line[i]].length)))
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length))
  const sep = width.map((w) => '-'.repeat(w)).join('  ')
  return [head.map((h, i) => pad(h, width[i])).join('  '), sep, ...body.map((line) => line.map((c, i) => pad(c, width[i])).join('  '))].join('\n')
}

/** 毫秒取整，给表格用。 */
export function ms(t0) {
  return Math.round(performance.now() - t0)
}
