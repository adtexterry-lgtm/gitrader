// SPDX-License-Identifier: CPAL-1.0
// gitrader-mcp：stdio 入口。宿主（Claude Code / Codex / Hermes / UNIGIT）把它当子进程拉起。
//   gitrader-mcp            启动 MCP 服务器（stdout 只放协议帧；日志走 stderr，且永不含令牌）
//   gitrader-mcp --check    验证连接：查一次钥匙级别并打印，成功退出 0，失败退出 1（给"粘贴配置后确认"用）
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { KernelClient, resolveConfig } from './client'
import { createGitraderMcp } from './server'

async function main(): Promise<void> {
  const cfg = resolveConfig(process.env)
  const client = new KernelClient(cfg)
  const mcp = createGitraderMcp({ client, log: (m) => process.stderr.write(`[gitrader-mcp] ${m}\n`) })
  // 启动时对一次级别：决定握手后第一份工具清单（失败不致命：内核没起来 / 还没有钥匙时仍可连上，调用时再如实报错）
  const problem = await mcp.refreshSession()

  if (process.argv.includes('--check')) {
    const s = mcp.session()
    if (problem || !s) {
      process.stderr.write(`FAILED: ${problem?.message ?? 'no reply from the kernel'}\n`)
      process.exit(1)
    }
    process.stdout.write(`OK  key ${s.keyId} · level ${s.level} (${s.tier}) · ${s.tools.length} tools: ${s.tools.join(', ')}\n`)
    return
  }

  if (problem) process.stderr.write(`[gitrader-mcp] not ready yet: ${problem.message}\n`)
  await mcp.server.connect(new StdioServerTransport())
}

main().catch((e: unknown) => {
  process.stderr.write(`[gitrader-mcp] ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
