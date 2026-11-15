> 许可证：CPAL-1.0。

# tools/bench · 性能基准脚本

三样东西一起量，一次跑完输出 **JSON + Markdown**（同源、数字一致）：

| 节 | 量什么 | 单位 |
|---|---|---|
| 回测吞吐 | 示例策略 × 合成 K 线（默认 10 万根）跑 `engine-core` 的回测：策略信号 + 撮合记账 + 统计 | 根 / 秒 |
| 指标库吞吐 | `engine-core` 指标库 44 个导出各跑一遍整段序列 | 根·指标 / 秒 |
| 报告渲染 | `@gitrader/report` 的 Markdown / HTML / both 单次渲染 | 毫秒 + 输出字节 |

## 怎么跑

在仓库根执行（不联网，不读密钥，只写 `--out` 目录）：

```bash
node tools/bench/run.mjs                                   # 默认 10 万根、3 轮、三节全跑
node tools/bench/run.mjs --bars 525600                     # 与 docs/perf-baseline.md 的 52.56 万根并排
node tools/bench/run.mjs --only backtest --bars 10000      # 只量回测吞吐，快速冒烟
node tools/bench/run.mjs --out tools/bench/results --quiet # 只落盘不打印 Markdown
node tools/bench/run.mjs --help
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--bars` | `100000` | 合成 1m K 线根数 |
| `--runs` | `3` | 每个策略回测轮数；第 1 轮记为「首次」，其余「热启」 |
| `--rounds` | `3` | 每个指标的轮数（同样分首次 / 热启） |
| `--render-rounds` | `5` | 报告渲染轮数 |
| `--strategies` | `ema-cross,mean-reversion,breakout,grid,dca` | 与 `bench/engine/run.mjs` 同五个、同顺序；`ema-cross` 用 `packages/engine-core/test/fixtures/strategies/ema-cross.ts`，其余用 `packages/engine-core/examples/strategies/<名>.ts` |
| `--only` | 三节全跑 | `backtest,indicators,render` 的任意子集 |
| `--out` | `tools/bench/results` | 输出目录（写 `bench.json` 与 `bench.md`） |
| `--quiet` | 关 | 不把 Markdown 打到 stdout |

输出目录里的两份文件同名同源：`bench.json` 给机器（CI / 回归比对），`bench.md` 给人看（表格 + 口径 + 判定）。默认落在 `tools/bench/results/`，是生成物（与 `bench/engine/results/` 同类）：要不要提交由主会话决定，本目录不设 `.gitignore`。

## 口径（与 `docs/perf-baseline.md` 对齐，只读那份文档，不改）

- **p50 / p95**，不用平均值；**首次（含 JIT 预热）与热启分开报**。
- **全部离线**：合成 K 线（几何随机游走，seed 1，与 `bench/engine/run.mjs` 同生成器算法）、纯函数渲染，不含网络、不含场所处理时间、不含读盘写盘。
- 回测吞吐 = 根数 / 墙钟秒，**不含数据生成**（单独报 `dataGenMs`）。
- 回测参数与 `bench/engine/run.mjs` 一致：策略集会先取默认值，有 `anchor` 的（grid / dca）再按首根 K 线锚成实际参数，两边跑的是同一组参数。
- 既有对照：`docs/perf-baseline.md` M1 v3 第 26 行「回测吞吐（52.56 万根 1m，同步核心）202–439 万根 / 秒，建议 N = 100 万根 / 秒」。这个区间出自 `bench/engine/run.mjs`（同五个策略、同参数、同数据），但**统计量不同**：它报含首次在内的各轮中位数，本脚本的「根 / 秒」是热启 p50，所以两边只能作参考并排，**同机同代码才可比**；要并排就用 `--bars 525600`。
- 指标库与报告渲染在既有口径里没有对应项，属于本脚本新增口径，Markdown 里已注明。
- 合成数据上的收益 / 成交数字**没有任何意义**，只用来量速度；报告里不出现任何预测或收益承诺（`lib/report.mjs` 的 `findPromiseWords` 在测试里扫输出）。

## 实现

```
tools/bench/
├── run.mjs                 # CLI：参数 → 数据 → 三节负载 → JSON + Markdown
├── lib/
│   ├── baseline.mjs        # docs/perf-baseline.md 的既有口径常量（只抄数字，不改原文件）
│   ├── dataset.mjs         # 确定性合成 K 线与合成回测结果
│   ├── env.mjs             # CPU / 核数 / 平台 / Node（不含主机名与用户名）
│   ├── loader.mjs          # 用仓库已有 esbuild 把工作区 TS 打成临时 ESM 再 import
│   ├── report.mjs          # 报告组装、Markdown 渲染、禁词自检、落盘
│   └── stats.mjs           # 分位数 / 中位数 / 汇总 / 吞吐
├── workloads/
│   ├── backtest.mjs        # 回测吞吐
│   ├── indicators.mjs      # 指标库吞吐（44 个指标，签名不对的记进 skipped 不崩）
│   └── render.mjs          # 报告渲染耗时
└── test/                   # node --test 小规模冒烟（不跑 10 万根全量）
```

工作区包是 TS，本目录全是 `.mjs`：`lib/loader.mjs` 用仓库里**已有**的 esbuild（不新增依赖）把 `engine-core` / 指标库入口 / `@gitrader/report` 各打成一个临时文件再 `import`，所以 `node --test` 不需要 TS 运行时、也不需要先构建整个工作区。

## 测试

```bash
node --test tools/bench/test/
```

小规模冒烟：400 根 K 线走真实 `engine-core` 回测、300 根走真实指标库、合成结果走真实渲染，外加一条真正 spawn `run.mjs --bars 400` 的端到端；**不跑 10 万根全量**（那是 `run.mjs` 的活）。

> 目录参数说明：本机 Node 22.23.2 的测试运行器只接受 glob、不展开目录（`node --test dir` 会把 dir 当模块解析）。`test/package.json` 把 `main` 指到 `test/index.mjs`，该入口按顺序 import 五个测试文件，因此 `node --test tools/bench/test/` 可用；等价写法 `node --test "tools/bench/test/*.test.mjs"`，单组用 `node --test tools/bench/test/report.test.mjs`。

## 会访问哪些主机

不访问任何主机。无网络调用、无第三方依赖新增；临时打包产物写在系统临时目录（`os.tmpdir()`），退出后由系统清理。

## 这份脚本不做什么

- 不测内核 / 工作台 / MCP / 连接器的端到端时延（见 `bench/engine/` 与 `scripts/verify/perf.mjs`）。
- 不写预测数字、不做收益比较、不出对比图。
- 不改 `docs/perf-baseline.md`：新数字只进 `--out` 目录，要不要回写由主会话决定。
