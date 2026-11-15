# REPORT · 标段 L · Bitget USDT 永续交易连接器（`packages/connector-bitget-trade`）

**改了什么**：新建 16 个源文件 ＋ 11 个测试文件。签名照 QD `bitget.py:198-258`（ts+method+path+sortedQuery+body，base64 HMAC）；下单 / 计划委托 / 保护单 / 撤单 / 全撤 / 改单 / 杠杆 / 持仓 / 余额 / 成交照 QD 现行端点；行情复用 `connector-bitget-data`，只补记录与报价缓存。市价走价带限价 + ioc。

**跑了什么**：11 文件 **366 例全过**（假服务器复算签名、校验方法与必填参数）；`tsc -p packages/connector-bitget-trade --noEmit` 退出 0；`hygiene.test.ts` 6/6；`node scripts/check-public.mjs` 退出 0。

**没做什么**：没接真网、没注册进内核 / CLI、没跑 `npm install`、没动其它包。没有 WebSocket 私有流（只做消息解析 `normalizeBitgetEvent`）；批量下单、`set-margin-mode`、死人开关都没做（`scheduleCancel` 回 5002）。

**需要主会话决定**：① `amend` 声明 `native` 但只对限价单成立（协议 `SupportLevel` 表达不了「部分支持」）；② `cancel-plan-order`、`orders-plan-pending` 两个端点 QD 未使用，按官方 v2 文档补，需真网核对，`cancel-all-orders` 是否覆盖计划单同样待核；③ 保护单是两步（`submit` 带 `tpsl` 回 1004，成交后 `placeProtection`），与 G 的取舍一致，是否接内核由你定；④ 保证金初始 / 维持为持仓折算值、`fundingSinceOpen` 恒 0；⑤ 渠道码 `X-CHANNEL-API-CODE` 缺省不发（不冒用 QD 的）。

## 十二条通用教训自查

| # | 要求 | 落点 | 结论 |
|---|---|---|---|
| 1 | 端点以 QD v5.6.5 当前实现为准 | `README` 端点表逐条带 `file:line`；QD 未用的两个端点已显式标注 | ✅ |
| 2 | 撤单 / 全撤 HTTP 方法照官方 | 三个撤单端点皆 **POST**；假服务器按方法表回 405（`test/trading.test.ts`） | ✅ |
| 3 | 非 GET 结果未知 → 3006 不可重试 | `rest.ts` 判 408 / 5xx / 断连 / `System error`；`trading.ts` 回 `status:'unknown'`，只发一次 | ✅ |
| 4 | 市价必须带 `maxSlippageBps`，发价带限价 + IOC | `orders.ts` 缺参回 INVALID_PARAMS、价带 `mid±bps` 贴 tick、`force=ioc` | ✅ |
| 5 | 持仓从交易所专用端点取 | `account.positions()` → `/position/all-position`；账户汇总只取余额 | ✅ |
| 6 | 密钥不进 `JSON.stringify` / inspect / 错误文本 | `rest.ts` 用 `#private`；测试断言三种出口都不含凭据 | ✅ |
| 7 | 数量 / 金额走协议 decimal | `precision.ts` + `parse.ts` 全用 `fx/mul/div/addDec/floorToStep`，无浮点加减 | ✅ |
| 8 | 假服务器复算签名并校验必填参数 | `fake-bitget.ts` 复算 base64 签名（不符回 40009）、缺参回 40001、方法错回 405 | ✅ |
| 9 | capabilities 老实 | `twap: none`、`market: emulated`、`batch.maxOrders: 1`、无 `deadman`；做不到的回 1004/5002 | ✅（amend 见待决 ①） |
| 10 | 私有流保留成交号 / 执行类型 / 零仓平仓行；可用余额用对字段 | `normalizeBitgetEvent` 保留 `tradeId`、maker/taker、零数量有号行；余额取 `available` | ✅ |
| 11 | 权重 0 也 `acquire(0)`；429/418 与 HL 同码 | `rest.spend()` 一律 `acquire`；429/418 → 3003 retryable + Retry-After（`test/signing.test.ts`） | ✅ |
| 12 | README 首句 + 不注册 CLI | README 第 3 行原句；`package.json` 无 bin，CLI 未引用 | ✅ |
