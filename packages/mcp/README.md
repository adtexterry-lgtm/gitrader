> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/mcp

Gitrader 的 MCP 服务器（stdio）：17 个工具，名称 / 描述 / 入参 schema 全部取自 `@gitrader/protocol` 的 `MCP_TOOLS`。

```
gitrader-mcp            启动（宿主把它当子进程拉起）
gitrader-mcp --check    验证连接：打印钥匙、级别、工具数；失败退出 1
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `GITRADER_AGENT_TOKEN` | Agent 钥匙令牌（`gitrader keys new agent …` 只显示一次） |
| `GITRADER_AGENT_TOKEN_FILE` | 令牌文件（只放令牌一行）；没有上一个变量时用它，可晚于宿主创建、可轮换 |
| `GITRADER_HOME` | 数据目录；没有 `GITRADER_API_URL` 时，每次调用从 `<home>/service.json` 读端口（只读端口） |
| `GITRADER_API_URL` | 可选，固定内核地址（只允许本机 `http://127.0.0.1:<port>`） |

宿主配置怎么写：`gitrader mcp snippet <claude-code|codex|hermes|unigit>`（令牌不写进配置）。

## 行为约定

- 默认加载：只读 + 提案 + 纸面组。钥匙 L0 = 13 个（L0 的 `note / experiment / backtest` 可写研究记录，不能交易），L1–L4 = 16 个，人打开"允许 Agent 调整布局"后 +1（workspace）。级别变化时发 `notifications/tools/list_changed`；钥匙被吊销或过期时工具清单清空并同样通知，错误原因以 `KEY_REVOKED` / `KEY_EXPIRED` 开头（仍是 AUTH_FAILED）；换了令牌后下一次列工具即恢复。级别随每次调用的返回带回，**不轮询**。
- **不自动发心跳**：内核把任何已认证调用都算作 Agent 存活，所以本进程只在 Agent 自己调用时才碰内核（启动时对一次级别除外）。
- 每次调用生成一个 `requestId`（UUID）；`actor` / `actorType` / `via` 由内核按已认证身份盖章。
- 错误原话透传：内核的 Problem（含 `ruleHits`、上游 `venue.message` 原文）原样放进工具结果（`isError`）。
- 注解（`readOnlyHint` / `destructiveHint`）只是提示；真正的放行在内核（`packages/kernel/src/api/agent.ts` 再查一遍加载条件与最低级别）。
- `order` 的描述写明：LLM 实盘开仓默认被策略拒绝（`denyLlmLiveEntries`）。

## 工具预算

`BUDGET.md` 由 `npm run budget -w @gitrader/mcp` 生成；`npm test` 会核对它与协议包一致，超预算即失败。

## 测试

`npm test`（单测 + 与真内核的 HTTP 联调）；冒烟：`node scripts/verify/mcp.mjs`（起内核 + 模拟场所 + stdio 拉起 MCP 走全流程）。
