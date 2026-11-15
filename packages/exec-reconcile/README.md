> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/exec-reconcile

执行对账**纯函数**包：输入「本地视图」（账本此刻相信的挂单 / 成交 / 持仓快照）与「场所视图」（连接器能给出的挂单 / 历史订单 / 成交 / 持仓），输出**差异分类 + 处理建议 + 证据**。

**红线：本包没有任何写入口。** 它不改账本、不下单、不撤单、不发请求、不读系统时钟；改账由内核按人定的规则执行。零第三方依赖，只新建本包。

```ts
import { reconcile, renderReport } from '@gitrader/exec-reconcile'

const report = reconcile({
  local: { accountId, orders, fills, positions, asOf },
  venue: { openOrders, historyOrders, fills, positions, asOf, truncated, unavailable },
  links, // 可选：改单链（客户端单号 ↔ 场所单号）
}, {
  now,                       // 必填：不读系统时钟，保证可复现
  clockSkewMs: 2_000,
  venueLatencyMs: 5_000,
  sizeTolerance: '0',
  positionTolerance: '0.0001',
  priceToleranceBps: 5,
  fillLookbackMs: 24 * 3600_000,
  staleAfterMs: 60_000,
  ownClientOrderIdPrefixes: ['gt-'],
  dedupeFallback: 'accept_with_risk',
})

report.verdict      // clean | attention | blocked
report.findings     // 差异码 + 建议动作 + 是否需人工 + 证据
report.inferredFills// 推断成交（全部 inferred: true，带依据与定价来源）
report.dedupe       // 去重键、重复到达、同号冲突
console.log(renderReport(report, { venueLabel: '交易所名' }))
```

## 一、差异分类（38 个差异码）

| 组 | 差异码 | 判定要点 |
|---|---|---|
| 本地有、场所无 | `local_open_venue_filled` / `local_open_venue_cancelled` / `local_open_venue_rejected` / `local_open_venue_partially_recorded` / `local_open_venue_missing` | 先看历史订单报告；再看有没有成交落在该单号上；都没有则看是否还在场所回报延迟窗口内 |
| 场所有、本地无 | `venue_order_unmapped` / `venue_order_external` / `local_terminal_venue_open` | 单号像我们的、账本没认领 → 交给人；前缀不属于我们 → 外部单，不自动接管 |
| 状态 / 数量漂移 | `order_state_drift` / `order_filled_size_drift` / `order_price_drift` / `order_reduce_only_drift` | 逐字段比；成交量方向不同给的结论不同（场所多 = 漏记；账本多 = 改单后场所重置） |
| 改单链 | `amend_chain_resolved` / `amend_chain_broken` / `amend_chain_ambiguous` / `order_venue_id_conflict` | 链上多单号、缺一段、一号多认领，分别处理 |
| 成交 | `fill_duplicate` / `fill_conflict` / `fill_orphan` / `fill_missing_inferred` / `fill_missing_unexplained` / `fill_recorded_excess` / `fill_total_exceeds_order` / `ledger_fill_duplicate` / `fill_dedupe_key_fallback` / `fill_dedupe_key_cumulative` / `fill_time_anomaly` | 去重 → 认领订单 → 缺口推断 → 账本侧重复 |
| 持仓 | `position_size_mismatch` / `position_missing_at_venue` / `position_missing_locally` / `position_side_mismatch` / `position_shape_mismatch` / `position_margin_mode_mismatch` / `position_entry_price_drift` | 按标的 × 方向 × 保证金模式比，净额与分方向都比 |
| 视图质量 | `snapshot_stale` / `venue_fills_truncated` / `venue_report_unavailable` | 视图不新鲜、回补截断、场所给不出某类报告：结论一律降级 |

「难以判断」的全部落到 `query_order_status` / `wait_and_recheck` / `review_*`，并且 `advice.requiresHuman = true`；每条差异都带 `advice.why`（为什么这么建议）与 `evidence`（哪份报告、哪条记录、哪个字段、什么值）。

## 二、推断成交

场所累计成交量比账本已记多出来的那部分，本包会给出一条 `InferredFill`：

- 必须 `inferred: true`，`basis` 逐条写依据（场所哪份报告说多少、账本已记多少、差额多少、价格从哪来、时间从哪来）；
- 定价来源只有两种：场所订单报告的成交均价（`avgFillPrice`，首选），或账本该单最后一笔成交价（`priceSource: 'local_last_fill_price'`，依据里写明是替代价）；
- 两者都没有 → 不猜价格，出 `fill_missing_unexplained`（阻断级，需人工）；
- 差额在 `sizeTolerance` 内不推断；账本多于场所不推断，改报 `fill_recorded_excess`；
- 每条推断成交带确定性 `id`（`inferred:<场所单号>:<账本已记合计>-><场所累计成交量>`）：同一缺口重复对账得到同一 id，内核可据此对「人已确认入账」的推断成交去重。

## 三、时间与去重键

- **所有比较带容差**：`clockSkewMs`（时钟偏差）+ `venueLatencyMs`（场所延迟）合成在途窗口，窗口内的「场所没看到」只提示等待重查，不判丢失；成交时间落在未来超出偏差、或早于回补窗口，单独报 `fill_time_anomaly`。
- **去重键优先级**：场所成交号（`venueFillId`）> 回退合成键 > 累计量键。
  - 回退键 = `单号|时间|数量|价格`：两笔真实成交这四项全同会被误判成重复（`fill_dedupe_key_fallback` 会写明这条风险，`dedupeFallback: 'needs_human'` 可改为直接交给人）。
  - 累计量键（`<order_id>:<cum_qty>`，Alpaca 形状）：同一笔成交跨源时间戳不一致会被判成冲突（`fill_dedupe_key_cumulative` 写明）。
  - 同号同量同价、只差时间戳且差值在 `clockSkewMs` 内 → 按重复处理（`fill_duplicate`，`tags` 带 `ts_drift_within_skew`，`detail` 写出毫秒差）；超出偏差仍是 `fill_conflict`（阻断，照内核规则按成交号冲突停机）；内容一致 → `fill_duplicate`（忽略）。

## 四、与内核的接口建议（**需要主会话决定，本包不改内核**）

现状（只读核对）：内核启动对账在 `packages/kernel/src/kernel.ts:365` `startupReconcile()`，做三件事——拉场所未结订单与最近成交、把本地挂单在场所查不到的先 `lookup` 再算 `unresolved`、按 `venueFillId` 回补成交（`packages/kernel/src/trading.ts:1113` 起 `applyFill` 以 `(accountId, venueFillId)` 唯一）。它**不比持仓、不比成交量、不区分「场所没有」与「场所给不出」**。

建议接线（三处，均需主会话批准后再改内核）：

1. **启动对账**（`startupReconcile` 里拿到 `StartupSnapshot` 之后）：把账本快照与场所视图映射成 `ReconcileInput` 跑一次 `reconcile()`，把 `verdict === 'blocked'` 与 `needsHuman` 作为原有的「保持 HALTED」依据之一；**不要**用本包的结论自动改账。
2. **周期对账**（对齐 Nautilus 的独立轮询间隔）：挂单 5–10 s 一次、持仓 10–30 s 一次、在途单 1–2 s 一次；只跑一层视图、失败不重试到打满预算（沿用内核现有速率预算）。
3. **呈现给人**：直接用 `renderReport()` 的文本进工作台「对账」面板与账本 `annotation`（`reconciliation` 类型已有），按 `severity` 分组；推断成交单独一栏，必须人点确认后才允许内核补记成交。

需要内核侧提供 / 补齐（事实，不是要求）：
- 账本成交映射进 `LocalFillView` 时必须带 `orderId`：缺口推断按 `orderId` 求和，缺了会让差额算大（本包测试里显式补齐）。
- `VenueView.historyOrders` 与 `unavailable` 由连接器声明：IBKR 不查 `completedOrders`、Gate 只查 `finished` 列表，都要在 `unavailable` 里说明，否则「查不到」会被读成「没有」。
- `links`（改单链）来源：内核现在把 replace 的身份映射放在内存（Alpaca 决定 2），重启后丢失；要不要落账本由主会话定。

## 五、测试

8 个测试文件 127 例（12 个源文件），`npx vitest run --config ../../vitest.config.ts --root .`。夹具形状取自六个加密连接器与 Alpaca / IBKR 的测试夹具（只读，来源逐条注在 `test/fixtures/venues.ts` 顶部），每家至少 3 个场景；收口报告里的遗留问题各有专门用例（`test/leftovers.test.ts`）。判定全程十进制字符串 + BigInt，不碰浮点。
