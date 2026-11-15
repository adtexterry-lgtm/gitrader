# 标段 K · Bybit USDT 永续交易连接器（施工报告）

**改了什么** 新建 `packages/connector-bybit-trade`：16 源文件 + 13 测试文件 + README / LICENSE。`rest`（HMAC 签名、
`ENDPOINTS` 方法表）、`orders`（价带限价 IOC、StopOrder 三件套、`orderLinkId` ≤ 36）、`trading`（create / cancel /
cancel-all / amend / set-leverage / margin-mode / trading-stop，四个写端点全是 POST）、`account`（wallet-balance、
position/list、realtime→history、execution/list 游标去重）、`parse`（`bybit|<execId>` 去重键、execType、平仓行）、
`ws`（auth / subscribe / ping 装配）、`budget`、`venue-errors`（QD 顺序 + Bybit 110xxx 段）、`capabilities`、
`market`（复用 `connector-bybit-data`）、`connector`。

**跑了什么** `vitest --root packages/connector-bybit-trade`：11 文件 **363 例全过**（假服务器复算签名 + 校验方法与必填参数）；
`tsc -p packages/connector-bybit-trade --noEmit`：0 错；protocol hygiene：6 例过；`node scripts/check-public.mjs`：退出 0。

**没做什么** 真网、真 WebSocket；内核 / CLI 注册；twap；裸 Market 单；场所级定时撤单（deadman）；提现；全市场 symbol 扫描；
真网限频实测（权重表按官方文档）。

**需要主会话决定** ① tpsl：Bybit 建单可带 TP/SL（`tpslMode=Partial`），但保护腿没有独立订单号，按 `clientOrderId`
对账会对不上，故 `attachToOrder / positionLevel` 都声明 false、带 tpsl 的 submit 回 1004，保护腿交内核成交后补挂；
② amend 只对 Limit 系原生，协议 SupportLevel 表达不了「部分支持」→ 声明 native + `x-amendScope` 写范围；
③ 追踪止损只能持仓级（`orderTypes.trailing_stop = 'none'`，走 `setTradingStop`，会覆盖该槽位已有 TP/SL）；
④ `receiptHash / requestWeight` 里下单权重恒 0（Bybit 口径）；⑤ 是否注册进内核。

## 十二条自查

| # | 教训 | 落实 | 证据（测试） |
|---|---|---|---|
| 1 | 端点照 QD 当前实现 | `rest.ENDPOINTS` 单一事实源，13 条路径全表；README 同步 | `qd-port.test.ts` 5 例 |
| 2 | 撤单 / 全撤 / 改单 HTTP 方法照官方 | 全 POST；假服务器按方法校验，DELETE 打过去回 404 | `trading.test.ts`「用 DELETE…404」 |
| 3 | 「结果未知」非 GET 一律 3006 | 超时 / 断网 / 5xx / 10000·10016·10018·10019 → 3006 不可重试，ack 状态 `unknown` | `rest.test.ts` 7 例、`trading.test.ts` 2 例 |
| 4 | 市价必带 maxSlippageBps → 价带限价 + IOC | 缺参 INVALID_PARAMS；`clampLimitPrice` 只收紧；参考价陈旧 STALE_PRICE | `orders.test.ts` 9 例 |
| 5 | 持仓取专用端点 | `/v5/position/list`（symbol 或 settleCoin），账户汇总只供余额 | `account.test.ts` 3 例 |
| 6 | 密钥 # 私有字段防泄漏 | 连接器 / BybitHttp 全 `#` 字段；子对象只收 secrets 数组 | `connector.test.ts` / `signing.test.ts` 各 4 例 |
| 7 | 数量 / 金额走 protocol decimal | `truncateToStep` / `snapToTick` / `addDec` / `subDec` / 定点 vwap | `precision.test.ts` 23 例 |
| 8 | 假服务器复算签名 + 缺参回真实码 | 复算 prehash；10001 / 10003 / 10004 / 110001 | `signing.test.ts` 26 例 |
| 9 | capabilities 老实 | market=emulated、trailing/twap=none、tpsl 两 false、amend 范围写明 | `capabilities.test.ts` 19 例 |
| 10 | 私有流归一保成交号 / 执行类型 / 平仓行 / 可用余额 | `bybit\|<execId>`、execType、`closedSize>0` 保留、`totalAvailableBalance` | `account.test.ts` / `ws.test.ts` 共 9 例 |
| 11 | 权重 0 也 acquire(0)；429/418 与 HL 同码 | 下单请求 acquire(0)；429/418 → 3002 + Retry-After + 预算退避 | `rest.test.ts` 4 例 |
| 12 | README 首句、不注册 CLI | 首句已写；无 CLI / 内核注册 | `capabilities.test.ts`「README 首句」 |
