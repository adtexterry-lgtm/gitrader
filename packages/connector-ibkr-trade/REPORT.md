# REPORT · B6.3 `packages/connector-ibkr-trade`（IBKR 美股交易连接器）

## 一、做了什么

新建包，零第三方依赖，抄 QD `ibkr_trading/{client,symbols,README}` 的流程与校验（合约归一、`orderRef` 确定性单号、bracket、clientId 1/7、端口表），线协议按公开 TWS API 文档与 ib_async（BSD-2-Clause）同名消息语义自写：握手 `API\0`+int32 版本、服务器问候 `v<ver> <time>`、int32 长度前缀帧、字段子集编解码。socket 只连回环，非回环构造拒绝，不走 Client Portal。最小子集：连接/重连、合约详情、限价/止损/止损限价/跟踪止损/bracket、撤单、全撤、挂单、持仓、账户摘要、成交与佣金、价带快照；改单 1004，K 线/L2 5002。假 TWS 用 TS 写、真 socket 真帧，校验 clientId 占用（后连者踢先连者）、账户、整数股、tick 倍数、跟踪百分比、超持仓卖出、未知撤单，并支持「收下不回状态」「收下即断线」两种 3006 场景。

## 二、验收（仓库根实跑）

- `vitest --root packages/connector-ibkr-trade run` → 9 文件 **208 例全过**（全离线，打本包假 TWS；无后台进程）。
- `tsc -p packages/connector-ibkr-trade --noEmit` → 退出 0。
- `vitest run --root packages/protocol test/hygiene.test.ts` → 6/6。
- `node scripts/check-public.mjs` → 1805 文件，0 失败；本包另按同一规则自扫（check-public 只扫已跟踪文件）：0 项。

## 三、需要主会话决定（事实）

1. **线协议未逐字节核对**：施工期禁联网、本机无 ib_async 源码，握手/字段序按公开文档重建，字段是文档序的子集（省掉本包不发的算法单参数等）。接真网前必须逐消息核（尤其 openOrder 完整字段序、GTD 时区、成交时间时区）。服务器版本协商取 `min(客户端 176, 服务器)`、下限 100——这个下限与常量也是文档口径，未对照源码。
2. **协议缺字段**：`AccountSnapshot` 没有日内交易次数 / 交易冻结 / 购买力等字段（八条 6 要求原样进快照），本包不改协议，另用 `accountRestrictions()` 原样暴露；是否给协议加字段由主会话定。
3. **开空不支持**：可借券要 `reqMktData` generic tick 236，本包最小子集未实现 → 超出持仓的卖出（开空）一律拒单（已如实写 README / 能力）。
4. `openOrder` 里协议 `type` 无「跟踪止损」，TRAIL 映射 `unknown`；`reqGlobalCancel` 全撤撤该 TWS 所有 clientId 挂单（含手动单），返回值逐条 ack 但撤单是全局动作。
5. 未注册 CLI / 内核、未改 lock / 根 package.json；`node_modules` 软链待统一 `npm install`。

## 四、十二条 + 美股八条逐条自查

| 条目 | 落在哪 | 测试背书 |
|---|---|---|
| 1 端点/端口以 QD 当前实现为准 | `src/ids.ts:26`（端口表）、`src/contracts.ts:29`（STK/SMART/USD 归一） | errors.test「端口表照 QD」、orders.test「美股 = spot/stocks/USD」 |
| 2 撤单/全撤方法照官方 | `src/trading.ts:294`（CANCEL_ORDER 帧）、`:368`（REQ_GLOBAL_CANCEL） | trading.test「按 clientOrderId 撤单」「全撤」×2 |
| 3 结果未知一律 3006 不可重试 + 按单号对账 | `src/trading.ts:446`（3006）、`:412`（reconcile） | trading.test 3006 ×3 + reconcile ×2 |
| 4 市价必须 maxSlippageBps + 价带限价 IOC | `src/compliance.ts:92`、`src/orders.ts:158` | orders.test 市价 ×4、trading.test「市价意图发 LMT+IOC」 |
| 5 持仓取专用端点 | `src/account.ts:198`（POSITION） | account.test 持仓 ×3 |
| 6 密钥/凭证走私有、不打印 | `src/ids.ts:51`、`src/session.ts:131`（只回环，无凭证） | connector.test「诊断输出不含凭证形状」 |
| 7 数量/价格走 decimal 定点 | `src/orders.ts`（`resolveSize`）、`src/compliance.ts:138` | orders.test 数量/价格 ×6 |
| 8 假服务器复算校验必填 | `test/helpers/fake-tws.ts`（`#placeOrder` 校验账户/整数股/tick/跟踪/卖空） | trading.test 拒单 201 / errors.test 110/111 |
| 9 能力老实（none + 1004） | `src/capabilities.ts:25-51` | connector.test 能力 ×7、orders.test take_*/twap |
| 10 成交保留去重键 | `src/account.ts:294`（execId / commission 关联） | account.test 成交 ×4 |
| 11 限流退避（IB 50/s） | `src/session.ts`（`#pace`，本地 45/s） | session.test 限速 ×2 |
| 12 README 首句红线、不注册 CLI | `README.md:1-3` | connector.test「不注册、只构造」 |
| 八条 1 时段来自场所日历 | `src/calendar.ts:73`（tradingHours/liquidHours） | calendar.test ×12 |
| 八条 2 休市不排队 / 盘前盘后 | `src/compliance.ts:57` | orders.test 时段 ×6 |
| 八条 3 市价价带 / 无权限拒单 | `src/compliance.ts:92`、`src/market.ts:96` | orders.test「无参考价拒单」、trading.test 无权限 |
| 八条 4 碎股不取整 | `src/compliance.ts:138` | orders.test 碎股/整数 ×3 |
| 八条 5 卖空需可借 | `src/compliance.ts:154` | orders.test 卖空 ×4 |
| 八条 6 账户限制原样上报、受限拒单 | `src/account.ts:156,189`、`src/compliance.ts:24` | account.test 限制 ×3、orders.test blocked ×2 |
| 八条 7 模拟/实盘不混（端口表） | `src/index.ts:99,104` | connector.test 端口 ×5 |
| 八条 8 能力老实（无资金费/强平价） | `src/capabilities.ts:25`、`src/contracts.ts:66` | connector.test 能力 ×7 |
