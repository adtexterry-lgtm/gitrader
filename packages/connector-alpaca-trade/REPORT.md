# REPORT · B6.2 · Alpaca 美股交易连接器（`packages/connector-alpaca-trade`）

**改了什么**：新建 21 个源文件 ＋ 10 个测试文件 ＋ README。鉴权是请求头密钥对（`APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`，不是 HMAC），密钥进 `#` 私有字段；下单 / 改单（PATCH）/ 撤单 / 全撤（官方 `DELETE /v2/orders`，207 逐行核）/ 查单（含 `by_client_order_id`）/ 挂单 / 持仓 / 账户 / 成交（`account activities` 的 `FILL`，活动 id 作去重键）/ 私有流 `trade_updates`（保留 `execution_id`）/ 原生 bracket·oto·oco 保护单。市价意图一律转「参考价 ± `maxSlippageBps` 的限价 + IOC」，无参考价即拒。行情只做参考价，K 线 / 盘口回 5002 指向行情包。

**跑了什么**：`vitest --root packages/connector-alpaca-trade` **10 文件 288 例全过**（假服务器校验鉴权头、方法表 405、必填参数 422、场所规则）；`tsc -p packages/connector-alpaca-trade --noEmit` 退出 0；`node scripts/check-public.mjs` 退出 0（1805 文件）。`protocol test/hygiene.test.ts` **6/6**（首轮曾因并行目录 `packages/connector-ibkr-trade/README.md` 尚未落盘而 5/6，该目录补齐后复跑 6/6）；本包 license 字段、LICENSE 字节一致、README 首行单独核对一致。

**没做什么**：没接真网、没注册进内核 / CLI、没跑 `npm install`、没动其它包与 lock。没有 K 线 / 盘口（属 `connector-alpaca-data`）、没有定时全撤（5002）、没有逐标的杠杆（账户级倍数，只能等于现值）、没有批量下单、没有公司行动处理。

**需要主会话决定**：① 协议 `OrderIntent` 没有「允许盘前盘后」字段 → 现用构造参数 `extendedHours` 显式声明（默认拒）；② 协议 TIF 没有 `day`，而小数股 / 扩展时段 Alpaca 强制 day → 由连接器把 gtc 降为 day（更短、更严）并写告警；③ `AccountSnapshot` 没有 `trading_blocked` / `pattern_day_trader` / `daytrade_count` → 经 `restrictions()` 单独上报，未加字段；④ `amend` 声明 native 但带腿单与市价价带单一律 1004（`SupportLevel` 表达不了部分支持）；⑤ OCO 父单 `limit_price` 取止盈价、FILL 无手续费（费用在独立 `FEE` 活动）、maker/taker 一律记 taker——接真网前需逐条核。

## 十二条通用教训自查

| # | 要求 | 落点 | 测试背书 |
|---|---|---|---|
| 1 | 端点以现行实现为准、路径自核并写出处 | `README` 端点表（QD `client.py:592-643` / `factory.py:463` / `README.md:27-30`）；`rest.ts:4` 注明头鉴权出处 | `rest.test.ts` 鉴权/数据主机 12 例；`assets.test.ts` 资产字段 14 例 |
| 2 | 撤单 / 全撤的 HTTP 方法照官方 | `trading.ts:257`（全撤 `DELETE /v2/orders`）；假服务器方法表 `test/helpers/fake-alpaca.ts`（`ROUTES`，错方法 405） | `trading.test.ts` 全撤 5 例（含「逐张 POST 撤单 0 次」断言） |
| 3 | 非 GET 结果未知 → 3006、不重发 | `rest.ts:183,228`、`errors.ts:5` | `rest.test.ts` 3006 组 7 例；`trading.test.ts`「POST 5xx → unknown + reconcile」 |
| 4 | 市价必须带 `maxSlippageBps`，发价带限价 + IOC | `orders.ts:284`、`orders.ts:99`、`precision.ts:70` | `orders.test.ts` 价带 8 例（含无参考价/陈旧/上限 2000bps） |
| 5 | 持仓从专用端点取 | `account.ts:6`、`parse.ts:228` | `account.test.ts` 持仓 6 例 |
| 6 | 密钥不进 stringify / inspect / 错误文本 | `rest.ts:105,135` | `rest.test.ts` 密钥不外泄 3 例 + 前缀拒绝 3 例 |
| 7 | 数量 / 金额走协议 decimal | `precision.ts:52,60`、`parse.ts`（`normalizeDecimal` 包装） | `precision.test.ts` 12 例；`account.test.ts` marginRatio 1 例 |
| 8 | 假服务器复算 / 校验必填参数 | `fake-alpaca.ts`（鉴权头、方法、必填、小数股 day、扩展时段 limit） | 全部 288 例都在假服务器上跑；`rest.test.ts` 缺 key 401 1 例 |
| 9 | capabilities 老实，做不到回 1004 / 5002 | `capabilities.ts:31,43,46,47`、`orders.ts:219,234`、`trading.ts:421` | `capabilities.test.ts` 15 例；`orders.test.ts` 1004 组 7 例；`trading.test.ts` scheduleCancel/杠杆 5 例 |
| 10 | 私有流保留成交号 / 执行 id / 零仓平仓行 | `stream.ts:70,96`、`parse.ts:340,357,385` | `stream.test.ts` 20 例；`account.test.ts` 成交去重 6 例 |
| 11 | 429 / 418 退避与 Problem 码一致 | `rest.ts:205`、`errors.ts:120`、`budget.ts`（`acquire(0)`） | `rest.test.ts` 429 组 2 例 + 预算 3 例 |
| 12 | README 首句原句；不注册 CLI | `README.md:3`；`package.json` 无 `bin`，CLI 未引用 | 文档项；`check-public` 与 protocol hygiene 的 README 首行断言覆盖 |

## 美股专属八条自查

| # | 要求 | 落点 | 测试背书 |
|---|---|---|---|
| 1 | 时段从场所日历取，不写死 | `sessions.ts:96,130,162,220`、`calendar.ts`（`/v2/calendar`、`/v2/clock`） | `sessions.test.ts` 34 例（含夏令时、提前收盘、节假日、空日历 fail closed） |
| 2 | 休市不排队；盘前盘后仅显式声明且 limit + day | `orders.ts:249`（休市拒）、`orders.ts:254`（扩展时段市价拒）、扩展时段非 limit 拒 | `orders.test.ts` 时段组 9 例；`trading.test.ts`「周六拒单不发请求」 |
| 3 | 市价仍走价带；无参考价拒单 | `orders.ts:284`、`orders.ts:99` | `orders.test.ts` 价带 8 例 |
| 4 | 碎股仅 `fractionable`，不合规拒（不取整） | `orders.ts:136`、`assets.ts`（step/min/fractionable） | `orders.test.ts` 碎股 8 例；`assets.test.ts` 4 例 |
| 5 | 卖空仅 `shortable` / `easy_to_borrow` + 账户允许 | `orders.ts:148,163,168,173` | `orders.test.ts` 卖空 8 例 |
| 6 | 账户限制如实上报，冻结即拒，不绕开 | `parse.ts:273`、`orders.ts:208`、`trading.ts`（submit 前置读限制） | `account.test.ts` 限制 7 例；`orders.test.ts` 冻结 1 例；`trading.test.ts` 冻结 2 例 |
| 7 | 模拟 / 实盘不混（PK / AK 前缀，构造期拒） | `rest.ts:105`、`connector.ts:146` | `rest.test.ts` 前缀 7 例 |
| 8 | 能力老实（无资金费 / 强平价，杠杆按倍数，不支持回 1004） | `capabilities.ts:31,64`、`orders.ts:219`、`trading.ts:421`、`connector.ts:341` | `capabilities.test.ts` 15 例；`trading.test.ts` 5 例；`orders.test.ts` 1004 组 |
