> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/sim-book

盘口级成交仿真的确定性核心：输入「盘口快照 / 增量 + 逐笔成交 + 我方订单」，输出逐笔成交回报。
不接内核、不联网、零第三方依赖（只用 `@gitrader/protocol` 的十进制工具）。

## 它解决什么问题

K 线级回测按下一根开盘价成交、成本按固定 bps 算，回答不了「这一单到底能不能按这个价成交、吃完这一档还有没有量」。
本包把盘口当真：每一档的挂单量是有限的，被吃掉就少一份；两张单在同一时刻不能吃同一份量。

## 三种记录

一行一条 JSON，字段固定，价格与数量一律写十进制**文本**（不收 JSON 数字，也不收 `1e-8` 这类指数写法）。

```jsonl
{"type":"book_snapshot","ts":1000,"seq":1,"instrument":"BTCUSDT","bids":[["100.5","2"],["100","3"]],"asks":[["101","1.5"]]}
{"type":"book_delta","ts":1001,"seq":2,"instrument":"BTCUSDT","side":"ask","action":"add","price":"101.5","size":"0.5"}
{"type":"trade","ts":1002,"seq":3,"instrument":"BTCUSDT","price":"101","size":"0.25","aggressor":"buy","tradeId":"t-1"}
```

| 记录 | 字段 | 说明 |
|---|---|---|
| `book_snapshot` | `ts`、`seq?`、`instrument`、`bids`、`asks` | 整簿替换；买档严格递减、卖档严格递增、不许重复档位、买一必须低于卖一 |
| `book_delta` | `ts`、`seq?`、`instrument`、`side`、`action`、`price?`、`size?` | `add` / `update` 必带 `price` 与 `size`；`delete` 只带 `price`；`clear` 都不带 |
| `trade` | `ts`、`seq?`、`instrument`、`price`、`size`、`aggressor?`、`tradeId?` | `aggressor` 为 `buy` / `sell` / `unknown`；主动方向决定吃哪一侧的挂单量 |

`ts` 是毫秒整数，整条记录流上非递减；`seq` 可选，一旦出现就必须每条都带且非递减。
`.gz` 后缀的文件在读写时自动压缩 / 解压。

## 校验器

```ts
import { validateJsonl, readJsonlText } from '@gitrader/sim-book'

const result = validateJsonl(readJsonlText('book.jsonl.gz'))
if (!result.ok) console.error(result.errors) // [{ line, code, message, field? }]
```

检查项：JSON 语法、记录类型、字段类型、十进制语法、数量必须为正、档位排序与去重、盘口不许交叉、
`ts` 单调、`seq` 一致且单调；结构通过后还会把整串记录真跑一遍盘口，抓「增量命中不存在的档位」。
`validateJsonl(text, { strictBook: false })` 可只做结构校验。

## 撮合

```ts
import { SimBook } from '@gitrader/sim-book'

const sim = new SimBook({ instrument: 'BTCUSDT' })
sim.apply({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', bids: [['100', '5']], asks: [['101', '5']] })

const report = sim.submit({ id: 'o-1', side: 'buy', type: 'market', qty: '1.5' }, 2)
// { status: 'filled', fills: [{ price: '101', qty: '1.5', liquidity: 'taker' }], avgPrice: '101', ... }
```

订单类型：`market`、`limit`、`stop_market`、`stop_limit`；有效期 `gtc` / `ioc` / `fok`；
修饰 `postOnly`、`reduceOnly`。行为约定：

| 形态 | 约定 |
|---|---|
| 市价 | 从对手方最优档逐档吃到吃完；吃不完的剩余不挂簿（`reason: insufficient_liquidity`）；一口都吃不到则拒单 |
| 限价 | 限价穿越才吃，成交价取档位价（不会比限价差）；吃不完的剩余挂簿，可撤 |
| post-only | 下单即会吃单则整单拒绝；只约束入场，挂上之后照常成交 |
| IOC | 能成交多少算多少，剩余作废，不挂簿 |
| FOK | 试算能整单吃下才落账，否则整单作废且**不消耗任何流动性** |
| 止损 / 止损限价 | 触发价被最新成交价穿过时转成市价 / 限价；未触发时挂簿等触发 |
| 减仓 | 数量按传入持仓截断（`notes` 里写明）；无仓可平或与持仓同向则拒单 |

挂单的两种成交路径：逐笔成交穿过挂单价时按挂单价成交（`liquidity: maker`，成交量从这一笔里分配，
两张挂单不会都吃到同一笔的全量）；新报价穿越挂单价时同样按**自己的限价**成交（`liquidity: maker`），
但仍然吃掉对手档位的流动性。只有下单 / 改单 / 刚到场的单才是主动方（`liquidity: taker`，成交价取档位价）。

## 挂单成交判定（三档，可配）

`fillModel` 决定「逐笔成交能不能让我方挂单成交」。成交价永远是自己的限价（maker）；三档只在**能不能算**上有差别：

| 档位 | 同价成交（成交价 = 我方限价） | 穿价成交（成交价优于我方限价） | 假设 |
|---|---|---|---|
| `conservative` 严格 | 不成交 | 成交，量 = min(剩余量, 本笔额度) | 穿价说明整档被扫过（前方挂单也被吃掉）；同价成交可能全被前方队列吸收 |
| `queue` 队列位置 | 先扣「挂单时该档显示量」当作前方量，扣完才成交 | 前方量一次性清零后成交 | 显示量 = 前方量（看不到自己的单、不考虑隐藏单）；前方量只减不增；同笔成交里前方量与我方共享额度 |
| `optimistic` 宽松（缺省） | 成交 | 成交 | 永远排在队首（触价即成交），等于 Q1a 的口径 |

队列位置在订单**到达场所**那一刻按该档显示量记一次（改价后重记）。同价有多张我方挂单时，每张各按显示量估前方量，偏悲观。

## 延迟模型

`latency` 给下单 / 改单 / 撤单各自的固定延迟（毫秒）+ 可选确定性抖动（32 位 xorshift，种子固定则序列固定），
语义只有一条：命令在「发出时刻 + 延迟」才到达场所，**按到达时刻的盘口撮合**，不是发出时刻的盘口。

```ts
const sim = new SimBook({ instrument: 'BTCUSDT', latency: { baseMs: 5, insertMs: 20, updateMs: 5, cancelMs: 10, jitterMs: 8, seed: 42 } })
const ack = sim.submit({ id: 'o-1', side: 'buy', type: 'market', qty: '1' }, 1_000)
// ack.status === 'accepted'，ack.notes 里写明「在途：下单延迟 N ms，预计 T 到达场所」
sim.arrivalOf('o-1')  // 到达时刻
```

- 在途的单不参与撮合、不吃流动性；撤单 / 改单先于下单到场时场所按未知单拒绝（`reason: unknown_order`），下单到场后照常撮合。
- 撤单在途期间订单仍然可能被行情成交（这正是延迟的意义）。
- 到达时刻恰好等于某条记录的 `ts` 时，按该毫秒**最后一条**记录之后的盘口撮合（同一毫秒取较晚那版，偏悲观）。逐条 `apply` 时同一毫秒后面还有记录，要传 `{ sameMsFollows: true }`，或改用 `applyBatch(records)`；默认逐条语义是「按该条之后」。
- `flush(ts)` 把在途命令按最后已知盘口走完（收流用）。
- 缺省零延迟 = Q1a 行为：命令在发出时刻就到场所。

## 费用

`fees` 给 maker / taker 两档费率（分数文本，负数 = 返佣），可按币种覆盖；佣金 = 成交价 × 成交量 × 费率，
18 位定点精确。累计账本：`feesOf(orderId)` 与 `feeSummary()`（maker / taker 分开）。

```ts
const sim = new SimBook({ instrument: 'BTCUSDT', currency: 'USDT',
  fees: { maker: '0.0002', taker: '0.0005', overrides: { USDT: { maker: '0', taker: '0.0004' } } } })
```

**资金费不在本包**：资金费是持仓在时间轴上的结算，不属于成交流水，请在上层持仓记账里算。

## 与 K 线模拟器的一致性对照

`test/parity.test.ts` 用 `packages/engine-core` 的 K 线模拟器跑同一份合成 K 线（夹具由
`scripts/gen-kline-parity.mts` 实数生成），在「无限流动性（深度 = 下单量 ×100）、零延迟、触价即成交」的退化配置下对照：

- 零滑点 + 盘口报开盘价：成交价与手续费逐笔相等（浮点 vs 定点只差舍入）。
- 有滑点（25 bps）+ 盘口只报开盘价：差异**恰好**等于「滑点参数 × 开盘价」——滑点在盘口世界里不是独立参数，要体现在报单价上；把滑点写进盘口后两边再次逐笔相等。
- 不复现的结构差（各有用例写清来源）：K 线在下一根开盘成交、盘口在信号那刻成交（差 = 开盘 − 收盘）；K 线仓位由权益 × 杠杆 / 价格算出、盘口按给定数量；K 线整笔按一个价、盘口逐档吃量（薄簿均价更差）；盘口有市场冲击，K 线没有。

## 确定性

`SimBook` 不读时钟、不用随机数、不做 I/O：同一串记录 + 同一串订单必得同一串回报（延迟抖动来自种子，可复现）。
时间戳一律由调用方随记录传入。

## 脚本（开发用，不随包发布）

```bash
# 吞吐：合成 100 万条盘口事件，打印每秒处理条数
npx esbuild packages/sim-book/scripts/bench-throughput.mts --bundle --platform=node --format=esm \
  --outfile="$TMPDIR/bench-sim-book.mjs" && node "$TMPDIR/bench-sim-book.mjs"

# 重新生成一致性对照夹具（跑的是 engine-core 的真实模拟器）
npx esbuild packages/sim-book/scripts/gen-kline-parity.mts --bundle --platform=node --format=esm \
  --outfile="$TMPDIR/gen-kline-parity.mjs" && node "$TMPDIR/gen-kline-parity.mjs"
```

实测（Windows 11 / Node 22.23，单线程）：100 万条 / 1.59 s ≈ **62.6 万条每秒**（空簿）、100 万条 / 1.48 s ≈ **67.4 万条每秒**（常驻挂单 + 队列位置判定；第二次跑受 JIT 预热影响）。

## 状态

仅本包自身可用：未注册到根工作区锁、未接入 `engine-core` 模拟器、未接 CLI。接入方式由主会话决定。
