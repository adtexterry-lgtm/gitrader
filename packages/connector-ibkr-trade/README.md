> 许可证：CPAL-1.0。

> **未经真网验证，不得接实盘。**

# @gitrader/connector-ibkr-trade · IBKR 美股交易连接器（socket API）

连**本机** TWS / IB Gateway 的 socket API（只连回环地址，非回环在构造时拒绝），不做 Client Portal Web API。
内核已为它写了装配代码（`packages/cli/src/connectors.ts`），但当前行为是——配置里有**主网 live 账户**时内核**直接拒绝装配**本连接器（启动时报一行错误后跳过这家）；本连接器恒以**纸面模式**（`mode: 'paper'`）接本机 TWS / IB Gateway。**所以现在不要指望在内核里用它下真单。** 所有下单仍经风控闸门。

## 端口 / 环境对应（照 QD `ibkr_trading/README.md`）

| 客户端 | 实盘端口 | 模拟端口 |
|---|---|---|
| TWS | 7496 | 7497 |
| IB Gateway | 4001 | 4002 |

`mode: 'paper'`（缺省）只接受 7497 / 4002，`mode: 'live'` 只接受 7496 / 4001；端口属于相反模式时构造直接拒绝。
自定义端口（假服务器 / SSH 隧道）必须显式 `allowCustomPort: true`。

## clientId

手动 1、自动化 7（本包缺省 7）。IB 官方码表 326：已有连接占用该 id 时新连接被拒；QD README 记为新连接顶掉旧连接。
两种都按断线 / 拒连处理：本包收到 326 时连接以 `VENUE_AUTH`（3005）失败并关闭，不重连、不抢连。

## 最小子集

连接 / 断线重连状态、合约详情（STK / SMART / USD）、限价 / 止损 / 止损限价 / 跟踪止损 / bracket、撤单、全撤、挂单、
持仓、账户摘要、成交与佣金；行情**只做下单价带要用的快照**（`reqMktData` snapshot）。
K 线 / L2 / 逐笔 / 历史数据不在本包（调用返回 5002）。改单一律 1004（IB 无原生改单）。

全撤是 **emulated**：读本账户挂单后，本连接 clientId 的单逐张走 `cancel()`；其它 clientId 的单（含 TWS 手动单 clientId 0）
只回 `ok:false` + `VENUE_REJECTED`（IB 只允许下单方自己撤）。不调用 `reqGlobalCancel`。

## 美股专属八条怎么落

1. 时段来自 `contractDetails.tradingHours / liquidHours / timeZoneId`（场所日历），不写死；节假日 = 日历 CLOSED 日。
2. 休市不排队：常规时段外的**市价**意图拒单；盘前盘后必须 `allowExtendedHours: true` 且只发限价 + DAY / IOC，
   并置 `order.outsideRth = true`。
3. 市价仍走价带：必须带 `maxSlippageBps`，发参考价 ± 滑点的限价 IOC；拿不到参考价（无行情权限）→ 拒单。
   价带、tick 倍数、名义额折股都用十进制 / bigint，不经过浮点取整。
4. 碎股：IB 现金股票没有 fractionable 标志 → 只收整数股，非整数拒单，不取整。
5. 卖空：可借券信息要 `reqMktData` 的 generic tick 236，本包未实现 → 卖出要求「可卖量 ≥ 数量」；
   `reduceOnly` 买入要求该账户有空头且空头量足够。IB 股票没有原生 reduce-only，本包只在下单前按已知持仓与规则拒单，
   `openClose` 永远发空、挂单 `reduceOnly` 一律 false。
6. 账户限制：日内交易剩余次数、购买力、账户类型等**原样**从账户摘要读出（`accountRestrictions()`）。
   IB 账户摘要没有冻结标志（ib_async 标签表无此项），`tradingBlocked` / `accountBlocked` 恒 false；
   受限账户由 IB 以 201 拒单，原文照传。
7. 模拟 / 实盘不混：见上面的端口表，构造时校验。
8. 能力老实：不支持的（止盈单型、twap、按单杠杆、定时全撤）回 1004 / 5002，不假装；没有资金费、没有强平价。

## 线协议版本与未核对项（如实列出）

- 线协议按 ib_async @ `ab629f3`（BSD-2-Clause）的 **v178 字段表**实现（`client.py` / `decoder.py` 的消息号、字段序、
  `UNSET_INTEGER` / `UNSET_DOUBLE` 语义）；`test/reference-wire.test.ts` 是审稿人独立手写的参照向量，本包实现让它原样通过。
- **只支持 API 服务器版本 178**：握手只报 `v178..178`，服务器回别的版本即 5001 并关闭连接。
- **未接真 TWS 验证**：字段序按参照源码写，接真网前仍应逐条消息对照一次。
- GTD 的 `goodTillDate` 用 IB Order 文档的 UTC 写法 `yyyyMMdd-HH:mm:ss`。
- 成交时间：`reqExecutions` 的 time 恒发空串，按本地时间过滤。支持纯秒数、`YYYYMMDD HH:MM:SS <IANA 时区>`、
  以及老格式 `YYYYMMDD  HH:MM:SS`（无时区）；老格式需要连接器选项 `twsTimeZone`（填 TWS 设置里的时区），
  没填或时区非法时该成交不丢、`ts` 用本地时钟并 `onWarn` 一次。
- 公司行动（拆股 / 分红）不在本批次范围。
- 对账不查 `completedOrders`：撤销且无成交的单重启后查不到。
- ExecId 更正（IB 只改最后一段）未合并。

## 用法

```ts
import { IbkrTradeConnector } from '@gitrader/connector-ibkr-trade'

const connector = new IbkrTradeConnector({
  mode: 'paper',
  port: 7497,
  clientId: 7,
  symbols: ['AAPL'],
  twsTimeZone: 'America/New_York',
})
await connector.start()                  // 连接 + 拉合约详情（TWS / Gateway 需先启动并登录）
await connector.refreshQuote('ibkr:AAPL') // 快照（市价意图的参考价）
const caps = connector.describe()         // 能力声明（含 x-ibkr 扩展键）
await connector.close()
```

## 测试

`vitest run --config ../../vitest.config.ts --root .`（全离线：每个用例打本包的**假 TWS**，真 socket、真 v178 帧格式，
随测试进程关闭，不留后台进程）。假 TWS 会校验收到的握手范围、clientId 占用（326 拒新连接）、账户、整数股、
tick 倍数、跟踪止损百分比、超持仓卖出、未知 orderId 撤单，并支持「收下但不回状态」「收下就断线」等场景。
