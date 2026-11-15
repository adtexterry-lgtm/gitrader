# 差异表格式（gitrader-parity-diff/1）与运行记录格式（gitrader-parity-run/1）

本文件是**格式契约**：测试台输出的 Markdown / JSON 按这里说的列与字段来读，别的工具要消费就直接按这份读。

## 一、运行记录（规范形）`gitrader-parity-run/1`

两侧各自归一到同一形状，才谈得上比对。归一实现：`lib/artifact.mjs`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | string | 固定 `gitrader-parity-run/1` |
| `side` | `backtest` \| `paper` | 哪一侧 |
| `runId` | string | 回测侧 = GEP jobId；纸面侧 = `paper:<accountId>` 或 `paper:absent` |
| `instrument` / `interval` | string | 标的与周期；两侧必须同值才有比对意义 |
| `source` | object | 回测 `{kind:'gep-backtest', jobId, specDigest, dataDigest, fillModel, engine}`；纸面 `{kind:'paper-state', version, orderSeq, fillSeq, accountId}` 或 `{kind:'absent', reason}` |
| `clock` | object | `{mode:'event-time'\|'system'\|'none', start, end}`。回测 = K 线事件时间；纸面 = 系统时钟（今天唯一可得的形态） |
| `capabilities` | object | `{orders, fills, equity, equityCurve}` 四个布尔：这一侧**有没有**这一类记录。缺的那类只记「无法核对」，不记「一致」 |
| `orders[]` | array | `{seq, clientOrderId, venueOrderId, instrumentId, side, type, tif, size, filledSize, price, avgFillPrice, status, createdAt, updatedAt}`；回测侧恒为空 |
| `fills[]` | array | `{seq, ts, side, price, size, fee, realizedPnl, orderRef, fillId, reason}` |
| `equity[]` | array | `[{t, v}]`，按时间升序；纸面侧只保证末点可核对 |
| `finalEquity` | number \| null | 最终权益（分析级，浮点） |
| `notes` | string[] | 这一侧自述的口径与局限（原样进差异表末尾） |

归一的两处**已知不对称**（不粉饰）：

1. **回测没有订单对象。** `packages/engine-core/src/strategy/simulator.ts` 只产出成交（`trades`），所以 `capabilities.orders=false`，订单序列一栏永远是「无法核对」。
2. **纸面 state 是滚动窗口。** `KEEP_ORDERS=500`、`KEEP_FILLS=2000`，更早的订单与成交已被丢弃；权益曲线只能用 state 末根 mark 重放，中段不可逐点比对。

## 二、差异表（Markdown）

列固定九列，顺序不许改：

| 序号 | 类别 | 键 | 字段 | 回测 | 纸面 | 差异 | 严重度 | 判读 |
|---|---|---|---|---|---|---|---|---|

- **序号**：1 起的行号，与 JSON `rows[].n` 一致。
- **类别**：`订单序列` / `成交序列` / `最终权益` / `能力声明`。
- **键**：订单用 `clientOrderId`（缺失时 `venueOrderId`）；成交用 `fillId`；权益用 `finalEquity` 或 `curve`。
- **字段**：`*` 表示整条缺失 / 多余；否则是具体字段名（`price`、`size`、`fee`、`ts`、`status`…）。
- **回测 / 纸面**：该字段两侧的值；`missing` / `present` 表示整条记录的有无。
- **差异**：纸面 − 回测，按 `toPrecision(12)` 去浮点尾巴；非数值字段为空。
- **严重度**：`阻断` / `应修` / `备注`。
- **判读**：这一行为什么会出现、往哪查。表格正文只写机制，不写结论性承诺。

## 三、严重度与判定

| 情形 | 严重度 |
|---|---|
| 订单：一侧有、另一侧无（`*`） | 阻断 |
| 订单：`status` 不同 | 阻断 |
| 订单：`size` / `price` / `side` / `type` 不同 | 应修 |
| 成交：一侧有、另一侧无 | 阻断 |
| 成交：`price` / `size` 超出容差 | 阻断 |
| 成交：`fee` 超出容差 | 应修 |
| 成交：`ts` 不同但在时间容差内 | 备注 |
| 最终权益：超出 `max(绝对容差, |回测值| × 相对容差)` | 阻断，否则备注 |
| 权益曲线逐点最大偏离 | 备注（两侧时间基不同） |
| 某一侧缺该类能力 | 备注，判读固定写「无法核对（不是一致）」 |

汇总 `summary.verdict`：有阻断 → `divergent`；无阻断但有「无法核对」→ `partly-unverifiable`；两者都没有 → `consistent`。**没有 `equal` 这个词**：本测试台只报「差多少」，不宣布「一致」。

默认容差（`lib/diff.mjs` `DEFAULT_TOLERANCES`）：价格 / 数量 / 费用 `1e-9`，权益 `1e-6` 绝对或 `1e-6` 相对取宽，成交时刻 `0 ms`（可按需放宽，写进产物 `tolerances`）。

## 四、JSON 形态 `gitrader-parity-diff/1`

```json
{
  "format": "gitrader-parity-diff/1",
  "generatedAt": "2026-10-21T13:07:02.692Z",
  "preflight": { "verdict": "stop", "checks": [], "missing": [], "capabilityMatrix": {} },
  "summary": { "total": 4, "byKind": {}, "bySeverity": {}, "verdict": "partly-unverifiable" },
  "tolerances": {},
  "rows": [],
  "sides": { "backtest": {}, "paper": {} }
}
```

产物目录（默认 `tools/parity/out/`）：`preflight.json`、`backtest-run.json`、`paper-run.json`（有纸面状态时）、`parity-diff.json`、`parity-report.md`。

## 五、停机分支长什么样

`preflight.verdict = "stop"` 时：`paper-run` 不出，`backtest-run` 照出（回测一侧的真实产出），差异表只含「能力声明」与「最终权益无法核对」几行，`summary.verdict = "partly-unverifiable"`，`preflight.missing` 逐条写「缺什么 / 建议加在哪」。**停机分支的差异表不是一次比对结果**，它只证明格式可用。
