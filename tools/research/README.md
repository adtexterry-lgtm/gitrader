> 许可证：CPAL-1.0。

# tools/research · 因子研究工具链

把本地 K 线文件跑成一份因子研究报告：全部 Alpha158 因子 × 未来 n 根收益的 IC / 滚动 IR / 分位组收益，
输出 Markdown + 单文件 HTML；另附扫描 / 走查结果的表格渲染。

只读写本地文件，**不联网**，不读任何密钥，不新增依赖（仅 Node 标准库）。

## 命令

```bash
# 因子报告：<K 线文件> -> <文件名>.factors.md + <文件名>.factors.html（同目录）
node tools/research/factor-report.mjs candles.csv
node tools/research/factor-report.mjs candles.csv --horizon 10 --window 60 --quantiles 5 --top 30 \
  --title "BTC 1h" --md out/factors.md --html out/factors.html

# 扫描 / 走查结果：runSweep / runWalkForward 的结果 JSON -> <文件名>.sweep.md + .sweep.html
node tools/research/sweep-report.mjs sweep-result.json            # 自动识别 trials / folds
node tools/research/sweep-report.mjs wf-result.json --kind walk-forward --top 20
node tools/research/sweep-report.mjs sweep-result.json --md out/sweep.md --html out/sweep.html
```

参数：

| 参数 | 缺省 | 含义 |
|---|---|---|
| `--horizon n` | 5 | 前向收益取未来第 n 根收盘 |
| `--window w` | 60 | 滚动 IC 的窗口（根） |
| `--quantiles q` | 5 | 分位组数 |
| `--top k` | 20（因子）/ 10（扫描）/ 20（走查） | 报告里显示的行数 |
| `--title` | 由文件名拼 | 报告标题 |
| `--md` / `--html` | 与输入同目录 | 输出路径 |

退出码：`0` 成功；`2` 参数不合法、文件读不到、JSON 结构不符。错误信息走 stderr，报告内容走文件。

## 输入格式

与 `@gitrader/data-files` 的解析口径一致（`packages/data-files/src/parse.ts`）：

- CSV：`t,o,h,l,c[,v]`，`t` 为 Unix 毫秒，可有表头行，坏行跳过；
- JSON：`[{t,o,h,l,c,v?}]`、`[[t,o,h,l,c,v?]]` 或 `{ "candles": [...] }`；
- 按 `t` 升序、重复时间保留先出现的那根；报告里带全文 sha256 作为数据摘要。

## 口径（与 engine-core 一致）

| 项 | 定义 | 出处 |
|---|---|---|
| 因子目录 | KBAR 9 + 价格 3 + 滚动 29 族 × 5 窗口 = **157 条**（不生成 VWAP0，因为 K 线没有 vwap 字段） | `packages/engine-core/src/strategy/alpha158.ts` |
| 因子公式 | 预热期为 null，第 i 项只用 ≤ i 的数据；分母为 0 记 0，数据不足记 null | `packages/engine-core/src/strategy/factors-alpha.ts` |
| IC | 因子值与未来 n 根收益的 Spearman 秩相关；有效点 < 3 或任一方零方差为 null | `packages/engine-core/src/strategy/factor-eval.ts` |
| 滚动 IR | 滚动 IC 序列的均值 / 样本标准差（ddof 1） | 同上 |
| t 值 | **Newey–West（HAC）**：滚动 IC 序列的均值 / 稳健标准误，Bartlett 核，滞后 L = 窗口 + 前向根数 − 2；不再用 IR × √有效点数（相邻滚动窗口重叠，那个 t 会虚高数倍） | `lib/stats.mjs` 的 `neweyWest`（库里 `icSummary(ics)` 不带 opts 时仍是 engine-core 的旧口径，只给 parity 对照用） |
| 分位组收益 | 按因子值升序等分 q 组，组内取前向收益均值；`Q5−Q1` = 高组 − 低组 | 同上 |
| 单调性 | 组序与组均值收益的秩相关 | 同上（`quantileMonotonicity`） |

## 为什么是 `.mjs` + 复制公式，而不是 `import`

工作区的因子代码是 TypeScript 源码、靠构建产物发布；本目录要在**不构建**的前提下被 `node` 直接跑
（`node --test` / 命令行）。所以 `lib/alpha158.mjs`、`lib/factor-eval.mjs`、`lib/stats.mjs` 是
**逐行复制**对应 TS 文件的公式，文件头写明出处；语义以 TS 版为准，两边改动需同步。

同理，`packages/report` 是 TS 包，这里不改它，只在 `lib/render.mjs` 里做了一个最小渲染层，
沿用它的两条红线：单文件 HTML（内联 CSS、无 `<script>`、无外链）、固定免责声明一行。

## 输出

- 因子报告：数据摘要（文件、sha256、根数、时间范围）+ 因子表（IC / 滚动 IR / t / IC>0 占比 / Q1、Q5、价差 / 单调性 / 有效点）
  + |IC| 最大因子的分位组收益表 + 口径与限制。
- 扫描报告：试验按 Sharpe 降序（`*` 标出结果里的最优组），参数列 + 收益 / 年化 / 回撤 / Sharpe / Sortino / 胜率 / 成交笔数 / 费用，
  汇总区含试验间方差、DSR、PBO。
- 走查报告：每折训练窗 / 测试窗 / 最优参数 / 训练与测试 Sharpe / 测试收益与回撤，汇总区含样本外 Sharpe、效率比、盲留出段。

报告只陈述历史数据上的统计量，不含任何收益推断。固定免责声明：本报告为历史数据上的因子统计结果，不构成任何预测或建议。

## 目录

```
tools/research/
├── factor-report.mjs          # 因子报告 CLI
├── sweep-report.mjs           # 扫描 / 走查结果渲染 CLI
├── lib/
│   ├── alpha158.mjs           # Alpha158 目录与 41 个因子函数（复制自 engine-core）
│   ├── candles.mjs            # K 线文件解析 + sha256
│   ├── factor-eval.mjs        # 前向收益 / rankIc / 滚动 IC / 分位组（复制自 engine-core）
│   ├── factor-report.mjs      # 报告数据结构与 Markdown / HTML 渲染
│   ├── render.mjs             # 最小渲染层（表格、转义、单文件 HTML、免责声明）
│   ├── stats.mjs              # mean / variance / stdev / quantile / 平均秩（复制自 @gitrader/stats）
│   └── sweep-render.mjs       # 扫描 / 走查结果渲染
└── test/                      # node --test（合成数据，数字为手算字面量）
```

## 测试

```bash
node --test tools/research/test/          # 4 个文件 29 例，全离线
node --test tools/research/test/factors.test.mjs   # 只跑某一组
```

正确性用例用合成 K 线，期望值是按公式手算后写死的字面量（例如窗口 [1,2,3] 的 MA3 = 2/3、
分位组价差 = 1）。另有 `parity.test.mjs` 把本目录的复制件与 engine-core 的 TS 源逐点对照
（防止 engine-core 改了口径、这里没跟上），对照依赖仓库里已有的 esbuild。

## 限制

- 单标的、逐 K 线因子：不做横截面 IC（多标的对齐需要多文件载入，本工具只吃一个文件）。
- 分位组收益是等权、无手续费、无滑点的前向收益均值，不构成任何交易过程的回测。
- 滚动 IR 的样本量取决于 K 线根数；根数少于 `window + horizon` 时报告会在「提示」里说明并显示「—」。
