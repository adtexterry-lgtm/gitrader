> 许可证：Apache-2.0。本包 Apache-2.0，可自由嵌入，无署名要求。

# @gitrader/protocol

统一交易模型、引擎协议 GEP、插件 / 块 / 工作区清单、Agent 钥匙 / 授权书 / 提案 / 接管、MCP 工具清单、审计账本——Gitrader 所有包共用的契约，落成类型、JSON Schema 和校验器。一切字段以这里为准；要加字段先在 `CHANGELOG.md` 登记。

契约来源：M0 契约 v0.1.1，包版本 v0.1.14（见 `CHANGELOG.md`）。契约疑点见 `OPEN-QUESTIONS.md`。

## 目录

| 路径 | 内容 |
|---|---|
| `src/model/` | 统一交易模型：`Decimal`（十进制字符串，品牌类型）、Instrument、Account、Order、Position、RiskPolicy、Origin、Problem … |
| `src/gep/` | GEP：方法名与参数 / 返回类型、事件、错误码、`engine.describe`、Binding、版本协商、`GepClient` / `GepServer`（类型级接口，不含传输）、引擎启动配置 `EngineLaunch` |
| `src/plugin/` | `gitrader-plugin/1` 清单、kind 与权限枚举（默认拒绝）、GSP 签名请求 |
| `src/block/` | `gitrader-block/1`、块桥、联动组、`gitrader-workspace/1`、布局 API |
| `src/agent/` | 授权书（对外四档 ↔ 内部五级）、提案状态机、`confirmToken`、接管三档、人面专属动作、`denyLlmLiveEntries` |
| `src/mcp/tools.ts` | 17 个 MCP 工具：名称、分组、描述、入参 schema、按授权书级别加载、预算 |
| `src/ledger/` | `LedgerEntry`、条目类型、`canonicalize()`（RFC 8785）、哈希输入构造 |
| `src/validate.ts` | `validateX()`（ajv，draft 2020-12） |
| `schemas/*.json` | 与类型一一对应的 JSON Schema，由 `scripts/build-schemas.mjs` 生成（`workflow.json` 是契约原文，手工维护） |
| `conformance/` | GEP 一致性测试套件（必测 / 可选分文件）、最小假引擎，见 `conformance/README.md` |
| `test/` | 单测；`test/fixtures/contract/` 是契约里的 JSON 示例，`test/fixtures/handwritten/` 是补的样例 |

## 用法

```ts
import { validateOrder, isDecimal, canonicalize, MCP_TOOLS, mcpToolsForLevel, negotiateVersion } from '@gitrader/protocol'

const r = validateOrder(data)
if (!r.ok) console.error(r.issues)
```

- 数值：订单、成交、持仓、余额、保证金、账本一律十进制字符串（`isDecimal` / `asDecimal` / `normalizeDecimal`），时间一律整数毫秒。
- 重新生成 schema：`npm run build:schemas -w packages/protocol`（`check:schemas` 只比对）。
- 测试：`npm test -w packages/protocol`（含对假引擎的一致性自测）；对真引擎跑套件见 `conformance/README.md`。
- 协议包不含传输、不含内核逻辑，也不依赖任何其他 `@gitrader/*` 包。

## Experiment 前向统计与 K 线摘要

Experiment 夹具由 `conformance/experiment/` 提供并经 schema 加载；其中未来内核契约步骤只表达预期。本包当前测试不以这些夹具执行 ladder、前向统计或摘要函数，内核运行时和真实页面 / 服务均未验。

`computeForwardStats()` 接收内核生成的前向切片，所有金额和仓位先以 Decimal 字符串和动态 BigInt 精度计算。仅纳入来源可归属到指定 executor、账本证明为 `kernel-observed` 或 `venue-confirmed`、并处于窗口与附加时间内的成交片段。汇总币种必须已经统一；协议不换汇。

权益从每个账户的窗口起点权益开始。多账户只有在同一时刻都提供有效快照时才形成总权益点；缺失的 UTC 日不补值。完整日点进入日收益样本，非日边界的阶段终点只参与总收益、末端未实现盈亏和回撤。非最终窗口没有快照时收益与回撤为零，末端未实现盈亏取起点；最终窗口必须有完整终点快照。回撤从起点权益和后续完整权益点计算。

往返按账户、标的和 positionKey 分组；同组片段必须首尾仓位连续。只有从零开仓并最终回到零的完整周期计入 roundTrips，净 realizedPnl 减费用大于零计为胜。窗口开始时已有的仓位残段不计为往返。

前向统计摘要为最终 `ForwardStats` 去掉 `digest` 后的 RFC 8785 JCS UTF-8 字节，经 Web Crypto SHA-256 计算。`candlesDigest()` 对单一标的和周期的 K 线只投影 `[t,o,h,l,c,v]`，按 `t` 升序排列并拒绝重复时间戳；不同流分别摘要。规范字节为 `gitrader-candles/1`、一个 LF、再接 JCS 数组；空数组合法，末尾不追加换行。摘要为 `sha256:` 加 64 位小写十六进制。K 线直接使用行情 number，不转换为 Decimal。
