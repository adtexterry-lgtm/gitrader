# REPORT · P7 · Gate.io 永续交易连接器（`packages/connector-gateio-trade`）

**改了什么**：新建 15 个源文件 ＋ 11 个测试文件（另 2 个测试助手）。签名照 QD `live_trading/gate.py:1-11,78-138`（`UPPER(method)\nPATH\nQUERY\nsha512hex(body)\nTS` → HMAC-SHA512，头 `KEY`/`Timestamp`(秒)/`SIGN`/`X-Gate-Size-Decimal`）；下单 / 撤单 / 挂单 / 成交 / 持仓 / 账户 / 杠杆 / 资金费照 QD 现行端点；数量按 `quanto_multiplier` 折成有符号张数，份额化合约带精度头；市价走价带限价 + `ioc`；行情复用 `connector-gateio-data`（注明来源），只补 `InstrumentRecord` 与报价缓存。

**跑了什么**：11 文件 **261 例全过**（假服务器复算 HMAC-SHA512、方法表回 405、缺参回 `400 INVALID_PARAM_VALUE`、未知单回 `404 ORDER_NOT_FOUND`）；`tsc -p packages/connector-gateio-trade --noEmit` 退出 0；`hygiene.test.ts` 6/6；`node scripts/check-public.mjs` 我包 0 失败（4 条失败全在 `packages/connector-okx-trade`，是 `/users/self/` 被本机路径正则误判，非本标段范围；本包 0 条）。

**没做什么**：没接真网、没注册进内核 / CLI、没跑 `npm install`、没动其它包、没建私有 WebSocket 连接（只做帧归一）。触发单 / 改单 / 批量 / 死人开关 / 逐仓 / 双仓都没做（能力位 none 或回 1004 / 5002）。

**需要主会话决定**：① 触发单（`price_orders`）QD 未实现，本包声明 `none` ＋ `tpsl` 两位 false，内核若需保护单只能撤旧挂新；② 手续费符号取「Gate 扣费为负 → 协议正为付出」，未经真网核；③ `maintenanceMargin` / `marginRatio` 置 0、持仓 `marginMode` 恒 `cross`（Gate 不给绝对值）；④ clientOrderId 对账是有界扫描（Gate 无按 text 查单端点），精确对账须传 `venueOrderId`；⑤ 下单 10 次/秒是本地自定上限，不是 Gate 公布值。

## 十二条通用教训自查

| # | 要求 | 落点 | 结论 |
|---|---|---|---|
| 1 | 端点以 QD v5.6.5 当前实现为准 | README 端点表逐条带 `gate.py:行号`；QD 未实现的 `price_orders` 显式标注不做 | ✅ |
| 2 | 撤单 / 全撤 HTTP 方法照官方 | 撤单 **DELETE** `/orders/{id}`；全撤逐笔 DELETE；假服务器按方法表回 405（`test/trading.test.ts:17`） | ✅ |
| 3 | 非 GET 结果未知 → 3006 不可重试 | `rest.ts` 判 408/5xx/断连/2xx 非 JSON；`trading.ts` → `status:'unknown'`、只发一次、按 clientOrderId 对账 | ✅ |
| 4 | 市价必带 `maxSlippageBps`，发价带限价 + IOC | `orders.ts` 缺参回 INVALID_PARAMS；`mid±bps` 贴 tick；`tif:'ioc'`；永不发 `price:"0"` | ✅ |
| 5 | 持仓从专用端点取 | `account.positions()` → `/futures/usdt/positions`（QD 注明 `dual_comp/positions` 不是集合端点） | ✅ |
| 6 | 密钥不进 stringify / inspect / 错误文本 | `rest.ts` `#private` ＋ `redactSecret`；三种出口都有断言（`signing.test.ts:22`、`connector.test.ts:8`） | ✅ |
| 7 | 数量 / 金额走协议 decimal | `precision.ts` ＋ `parse.ts` 全用 `fx/mulDec/subDec/floorToStep`，无浮点加减 | ✅ |
| 8 | 假服务器复算签名并校验必填参数 | `fake-gate.ts` 复算 HMAC-SHA512、缺参回 `INVALID_PARAM_VALUE`、方法错 405、未知单 404 | ✅ |
| 9 | capabilities 老实 | `stop_*/take_*/trailing/twap = none`、`amend = none`、`tpsl` 两位 false、`batch.maxOrders:1`、无 `deadman`；对应 1004 / 5002 | ✅ |
| 10 | 私有流保留成交号 / 执行类型 / 零仓平仓行 | `normalizeGateEvent` 保留 `id`、`role`、零数量有号行 | ✅ |
| 11 | 权重 0 也 `acquire(0)`；429/418 与 HL 同码 | `rest.spend()` 一律 acquire；429/418 → 3003 retryable ＋ Retry-After | ✅ |
| 12 | README 首句 ＋ 不注册 CLI | README 第 5 行原句；`package.json` 无 bin，CLI 未引用 | ✅ |
