# REPORT · B6.1 Alpaca 只读行情

## 改了什么
新建本目录 20 文件（src 5、test 10、README / LICENSE / package.json / tsconfig / 本报告）。只读：`/v2/assets` → Instrument、数据主机 bars（IEX 缺省、SIP 可配）、snapshot → quote / 一档盘口、`/v2/calendar` + `/v2/clock` → sessions（America/New_York，不写死开盘收盘）。零第三方依赖、无 WS、密钥私有字段。每个端点在 `src/parse.ts:3-16` 写出处。

## 跑了什么
`vitest --root packages/connector-alpaca-data`：9 文件 71 例全过；`tsc -p ... --noEmit` 退出 0；`node scripts/check-public.mjs` 退出 0（1805 文件，本包未入库，另按同规则手扫 0 项）；protocol `hygiene` 5/6 — 红的是同批在写的 `packages/connector-alpaca-trade/README.md` 缺失，与本包无关。夹具手写，未经真网核。

## 没做什么
没有任何下单 / 账户路径（11 方法抛 `CAPABILITY_UNSUPPORTED`，假 fetch 零调用）；无 L2（`book()` 只最优一档）；不处理拆股分红（`adjustment=raw`）；未注册内核 / CLI；未跑 git / install / 联网。

## 需要主会话决定
① 协议 `sessions` 是周模板，装不下节假日与提前收盘（现经 `tradingCalendar()` / `isOpenAt()` 按接口处理）；② `Instrument` 无 `fractionable` / `shortable`，现走 `assetFlags()`；③ 无分档最小报价单位字段，只填 `maxDecimals: 4`；④ hygiene 红项待 B6.2 补齐后复跑。

## 美股八条自查

| # | 条 | 落点 | 测试背书 |
|---|---|---|---|
| 1 | 时段来自接口、tz 纽约、盘前盘后另列、节假日/提前收盘以接口为准 | `src/parse.ts:336`（buildSessions）、`src/market.ts:138`（refreshCalendar）、`src/market.ts:193`（isOpenAt 按当天 open/close） | sessions.test.ts:26 / 60 / 81 / 90；日历为空即失败 :75 |
| 2 | 休市不排队、时段外拒单 | 本包无下单路径：`src/connector.ts:159`（submit 只读抛错）；时段判定交调用方 `isOpenAt` | readonly.test.ts:40 / 61；sessions.test.ts:90 |
| 3 | 市价仍走价带 | 无市价能力：`src/connector.ts:30-33`（orderTypes 全 `none`）、`:42` `x-data-only` | capabilities.test.ts:21 |
| 4 | 碎股只在标的声明可碎时 | 数量按整数股 `src/parse.ts:485`；碎股标志 `src/parse.ts:451`（assetFlagsOf）、`src/market.ts:255` | instruments.test.ts:80 / 39 |
| 5 | 卖空只在可借时 | `shortable` / `easy_to_borrow` 同上 `src/parse.ts:451`；包内无开空路径 | instruments.test.ts:80 |
| 6 | 账户限制如实上报、冻结即拒 | 只读包不提供账户快照：`src/connector.ts:152`（accountState 抛错） | readonly.test.ts:40 |
| 7 | 模拟 / 实盘不混 | 环境声明 → 基址 `src/parse.ts:114`；PK/AK 前缀 `src/parse.ts:150`、`src/parse.ts:161`；构造期调用 `src/market.ts:98` | auth.test.ts:51 / 59 / 87 / 94 |
| 8 | 能力老实（无资金费 / 强平价 / 未支持回 1004） | `src/connector.ts:25-45`（全 none + `x-book: top-of-book` + history 10000）；context 无资金费键 `src/market.ts:367` | capabilities.test.ts:21 / 45；quotes.test.ts:95 |

十二条中与只读行情相关的部分：错误码映射 `src/http.ts:112-131`（401/403 → VENUE_AUTH、404 → INVALID_PARAMS、429 退避）、密钥不打印 `src/http.ts:50,58`、分页上限 `src/parse.ts:40-49`、请求前预算 `src/http.ts:76`、README 首行红线句。
