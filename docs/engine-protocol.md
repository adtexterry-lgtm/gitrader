# 引擎协议（GEP）

引擎是跑策略、回测的后端。Gitrader 不绑定任何一个：它只定义一份协议 **GEP（Gitrader Engine Protocol）**，谁都可以按协议把自己的后端接进来，任何语言、跑在哪都行。随包的 `gitrader-core` 只是参考实现，而且是个空引擎（不带策略、数据、因子）。

## 协议是什么

- **语言无关的 JSON-RPC 2.0**，带能力协商：连上后先 `gep.hello` 协商版本，再用 `engine.describe` 拿到引擎自己声明的能力位（支持哪些场所、回测 / 回放 / 策略 / 热更新、是否能自己连场所……），宿主只按能力位判断，不猜。
- **三种传输**：
  - 本地子进程 stdio（每行一个 JSON，NDJSON）——内核拉起；
  - 本机 WebSocket（只监听 `127.0.0.1`，路径 `/gep`，子协议 `gep.v0`）；
  - 远程 `wss://`，令牌或 mTLS 鉴权。令牌**放在 `gep.hello` 的参数里，不放 URL**。
- 本地子进程拿到的一次性令牌在环境变量 `GITRADER_GEP_TOKEN` 里；子进程**不继承**你的其他环境变量。
- 两个方向：宿主调引擎的方法（`strategy.*`、`backtest.*`、`engine.halt` ……），引擎调宿主的方法（`host.order.place`、`host.market.history`、`host.market.fundingHistory`、`host.risk.precheck` ……）。引擎事件走带序号的 `events` 流（有序、去重、断线续传）。
- 风控的分工：宿主把风控策略推给引擎（`risk.policy.push`），引擎**只能据此收紧**；引擎必须实现 `engine.halt`（三档接管），宿主按需随时叫停。真正强制的风控在宿主。
- 厂商扩展方法用 `x-<vendor>.` 前缀（如 `gitrader-core` 的工作流与策略文件夹），必须有对应的能力位，没声明就调用返回 5002。

## 去哪里看规范

唯一出处是 `packages/protocol/`，不要在别处抄字段：

| 要什么 | 在哪 |
|---|---|
| 方法清单、参数 / 返回类型、错误码 | `packages/protocol/src/gep/` |
| JSON Schema（可直接拿去校验你自己的输入输出） | `packages/protocol/schemas/gep.*.json` |
| 变更记录与字段登记 | `packages/protocol/CHANGELOG.md` |
| 一致性测试套件 | `packages/protocol/conformance/`（用法见该目录 `README.md`） |
| 参考实现 | `packages/engine-core/` |

## 接你自己的引擎

1. 用任何语言实现 GEP：先过 schema 校验，再对着一致性套件跑，直到必测项（T01–T27）和模式 A 全过：

   ```
   cd packages/protocol
   GEP_LAUNCH='{"command":"<你的可执行文件>","args":["--gep","stdio"]}' npm run conformance
   ```

   对已在运行的 ws 端点用 `GEP_ENDPOINT` + `GEP_TOKEN`；两个都不设则对内存假引擎自测。
2. 在 `gitrader.json` 的 `engines[]` 加一行（字段见 `docs/config.md`）：

   ```json
   { "id": "my-engine", "enabled": true,
     "launch": { "command": "C:/engines/my-engine.exe", "args": ["--gep", "stdio"] } }
   ```

3. 重启 `gitrader serve`，`gitrader engines list` 看状态（`ready` 才算接上），再 `gitrader engines bind my-engine` 绑到纸面账户（要 PIN）。**绑定本身不给任何权限**，权限永远来自授权书加风控闸；绑纸面账户时内核给引擎签一份只读写纸面的授权书，实盘账户必须由你另外签发。
4. 你的 Agent 通过 MCP 的 `engines` 工具启停策略；当前实盘账户启动策略会直接拒绝；S5 将补 `propose.control` 与人面批准流程。

**M1 现状（如实）**：本地子进程（stdio）引擎可用；已在运行的引擎（本机 ws / 远程 wss）用令牌鉴权、`tokenRef: "env:<变量名>"` 可用（本机 loopback ws 验过，真远程 wss 与 mTLS 未验）。引擎自己连场所下单（模式 B）的内核侧接线 M1 未做，协议里有定义，一致性套件里有对应的可选测试。

## 两种接入模式

| | 模式 A：经工作台连接器 | 模式 B：引擎自己连场所 |
|---|---|---|
| 怎么下单 | 引擎把订单意图交给宿主（`host.order.place`），宿主过授权书和风控闸后发往场所 | 引擎直连交易所 / 经纪商 |
| 密钥 | 只在内核钥匙库，引擎拿不到 | 你直接配给引擎，Gitrader 不保存；必须用独立的 API 钱包或子账户 |
| 风控 | **强制**，引擎只能收紧 | **只是建议**（推送 + 每单预检 + 事后对账），界面标"外部执行 · 风控为建议性" |
| 记录 | 全链完整 | 以引擎上报为准，内核尽量独立核对 |

"风控不可绕过"的承诺只覆盖模式 A，以及你手动下的单和 Agent 经 MCP 下的单。

## 随包的 gitrader-core

- 策略放在 `~/.gitrader/engines/gitrader-core/strategies/`，丢文件进去就是安装（校验、热加载）；随包只有一个没有任何交易逻辑的空白模板 `packages/engine-core/strategy-template/strategy.ts`。
- 回测不带数据集：输入要么向宿主要（内核录制的行情），要么你自己的 CSV / JSON 文件（必须带 sha256，对不上整个任务失败）。回测结果会写明手续费、滑点、成交模型；资金费按宿主方法或 `spec.data.files[].kind = "funding"` 的文件逐点结算，强平在请求时按维持保证金比例用最坏盘中价检查，装不到资金费点时结果里如实写 `assumptions.funding = false` 并给 warning。

  引擎在回测里会用到的宿主方法（完整清单与字段登记见 `packages/protocol/src/gep/` 与 `packages/protocol/CHANGELOG.md`）：

  | 宿主方法 | 要求 | 入参 | 出参 |
  |---|---|---|---|
  | `host.market.fundingHistory` | 可选 | `{ instrumentId, from, to? }` | `{ points: FundingRatePoint[], complete: boolean }`；`FundingRatePoint = { instrumentId, t, rate, premium? }` |

  引擎调用可选方法遇到 `METHOD_NOT_FOUND`（宿主未实现）时降级为 `assumptions.funding = false`，在结果 `warnings` 里说明原因，不按错误处理。
- 详细说明、校验规则、基准跑法见 `packages/engine-core/README.md`。
