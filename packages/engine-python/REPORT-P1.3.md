# REPORT · P1.3 回测循环 + 跨引擎一致性

**改了什么**（只新建，未改任何既有文件）
- `engine/backtest.py`：`Simulator` 逐条移植 `simulator.ts`——next-bar-open、吃单费、不利滑点、资金费点窗口 `(prevT, c.t]`、强平 + 罚金 + 破产、单根成交量上限、手数归一（含 4 ulp 吸附）、保护规则（先于策略、同根优先级）、`stats` 按 `toFixed` 口径取整；另有 `SimOptions` / `resolve_sim_options` / `infer_interval_ms` / `simulate_series` / `run_backtest`（预热门控 `i-1 >= warmup` 与 TS 同序）。
- `tests/test_backtest.py`：39 例（语义 32 + 一致性 7）。
- `tests/fixtures/export-ts-backtest.mjs` + `ts-backtest.json`：用仓库自带 esbuild 打包 engine-core，在同一份 600 根合成 K 线（另加 60 根急跌序列）上跑 7 个用例出夹具。

**跑了什么**
`python -m unittest packages/engine-python/tests/test_backtest.py` → 39 例全过；全包 4 个测试文件 240 例全过。一致性逐值比对：232 笔成交、3900 个权益点、全部 `stats` / `funding` 字段，**最大绝对偏差 0.0**（门槛 1e-9）。ema-cross 13 笔 / 权益 13652.17；grid 61 笔 / 10199.42；dca 29 笔 / 10479.54。扩展四例：资金费 + 强平 + 手数归一 15 笔（fundingPaid 23.644314）、成交量上限 unfilledShare 0.989711、保护规则 protectionExits 15、急跌强平 liquidations 1（finalEquity 0）。夹具重跑 md5 不变。

**没做什么**
没把 `gep.py` 的 `backtest.*` 作业改为调用本模块（仍用引擎内自带 `run_bars`）；不碰兄弟蜂文件、不 git / install / 联网。

**需要主会话决定**
1. TS 的 `resolveSimOptions`（`backtest.ts:29-48`）不透传 `protection` / `lotStep` / `minLot`，`runBacktest` 因此用不上这三项；Python 侧已透传（缺省行为不变）。是否在 engine-core 补（不在我可改范围）。
2. grid 只做多、600 根内未回到空仓 → `trips 0`，`winRatio` / `profitFactor` 对网格类恒空；是否另立「按格配对」口径。
3. 夹具 JSON 285 KB，入库体积是否可接受。
