> 许可证：CPAL-1.0。

# bench/engine

`node bench/engine/run.mjs [--bars 525600] [--runs 3] [--decisions 3000] [--out <文件>]`

量三样东西，结果写到 `results/engine-bench.json`：

1. 回测吞吐（根 / 秒）：策略信号 + 撮合记账 + 统计，同步核心，合成 1 分钟线 52.56 万根（一年）。
2. 端到端 `backtest.run`（经 GEP 任务，宿主分页给 K 线，结果走 `host.artifact.put`）。
3. 决策延迟 p50 / p95 / p99：宿主推一根新 K 线 → 引擎发出 `host.order.place`，进程内内存传输、假宿主零延迟，量的是引擎自己的开销。

数据是确定性合成的（`src/util/synth.ts`，固定种子），**收益数字没有任何意义**，只用来量速度。策略文件走和产品一样的加载器：最小均线用 `test/fixtures/strategies/ema-cross.ts`，其余用 `examples/strategies/`。
