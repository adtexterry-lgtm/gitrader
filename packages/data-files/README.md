> 许可证：CPAL-1.0。

# @gitrader/data-files

本地历史数据文件工具包：把本机的 K 线 / 资金费文件读成报告与清单，供 `BacktestSpec.data.source = 'files'` 使用。纯函数 + 一个可导入的 CLI（`run(argv)`），只用 Node 标准库，不联网。

```ts
import { inspectCandleFile, normalizeCandleFile, manifestFor, renderReport } from '@gitrader/data-files'

const r = inspectCandleFile('btc-1h.csv', { root: 'data' })  // 行数 / 周期 / 缺口 / 重复 / ohlc 违规
const r2 = inspectCandleFile('btc-1h.txt', { format: 'csv', root: 'data' }) // 扩展名不认识时显式指定格式
console.log(renderReport(r))
normalizeCandleFile('btc-1h.csv', 'btc-1h.json', { root: 'data' })   // 写成引擎规范 JSON { candles: [...] }
manifestFor([{ path: 'btc-1h.csv', kind: 'candles' }, { path: 'funding.csv', kind: 'funding' }], { root: 'data' })
// [{ path: '<绝对路径>', kind: 'candles', format: 'csv', sha256: 'sha256:…', bytes: 12345 }, …]
```

### 路径约束（`root`）

`root` 是**可选**约束：给了 `root`，`path` / 输出路径解析后必须落在它里面，否则直接抛错
（`data file escapes the data root` / `output file escapes the data root`）；**没给 `root` 时不约束**，
只把路径解析成绝对路径（与批 10 之前的行为相同）。启用约束后先做词法解析（挡 `../` 与绝对路径逃逸），
再对最长的已存在祖先做 `realpath` 复查（挡符号链接）。扩展名白名单仍保留，作为第二道闸。

**任何把 data-files 接到 Agent / 插件 / 远程调用面的代码必须传 `root`**。CLI 的 `--root=<dir>` 同义。

```ts
inspectCandleFile('../outside.csv')                  // 不约束：按当前工作目录解析
inspectCandleFile('../outside.csv', { root: 'data' }) // 抛错：越界
inspectCandleFile('/etc/passwd.csv', { root: 'data' }) // 抛错：绝对路径同样要被 root 覆盖
inspectCandleFile('btc-1h.csv', { root: 'data' })    // ok：data/btc-1h.csv
normalizeCandleFile('in.csv', '../out.json', { root: 'data' })  // 抛错：输出越界
```

CLI（本包不加 `bin`，按需自己接线）：

```ts
import { run } from '@gitrader/data-files'

const code = await run(['inspect', 'btc-1h.csv', '--root=data'])       // 0；`--kind=funding` 检查资金费
const code2 = await run(['normalize', 'in', 'out.json', '--root=data'])
const code3 = await run(['manifest', 'a.csv', 'b.json', '--root=data']) // 0；2 = 用法 / 读文件 / 格式错误 / 路径越界
```

`run` 不调用 `process.exit`，默认写 `process.stdout` / `process.stderr`，也可以传 `{ stdout, stderr }` 自己收；`runCaptured` 直接返回 `{code, stdout, stderr}`。

## 解析口径（与引擎逐字一致）

与 `engine-core/src/runtime/data.ts` 的 `parseCsv` / `parseJson` / `parseFundingCsv` / `parseFundingJson` 同一套规则：

- K 线 CSV：列 `t,o,h,l,c[,v]`，`t` 为 Unix 毫秒，可有一行表头（首行首列不是数值即当表头）。字段不足 5 个或任一列不是有限数的行跳过；缺 `v` 按 0。
- K 线 JSON：`[{t,o,h,l,c,v?}]`、`[[t,o,h,l,c,v?]]` 或 `{ "candles": [...] }`；坏项跳过。
- 资金费 CSV：`t,rate[,premium]`（`premium` 不参与解析）；资金费 JSON：`[{t,rate}]` / `[[t,rate]]` / `{ "points": [...] }`，`rate` 允许数字字符串。
- 一律按 `t` 升序、同一 `t` 只保留先出现的那一根（引擎装载时也这样去重）。
- 资金费 CSV 在引擎里不排序，本包为了出 `from` / `to` 与重复计数先排序去重——接受 / 拒绝规则不变。

## 报告字段

`rows` = 非空行数（含表头）/ JSON 项数；`parsed` = 成功解析的行数 / 项数（去重前）；`skipped` = 既不是表头也不是合法数据的行数。因此恒有 `rows = 表头(0|1) + parsed + skipped`，实际可用根数 = `parsed − duplicates`。

- `from` / `to`：去重后首根 / 末根的开盘时间（毫秒），无数据为 `null`。
- `interval`：相邻 `t` 差的众数。`label` 对齐 protocol 的 `CANDLE_INTERVALS`，对不上为 `null`（`1M` 是日历月，没有固定毫秒，永远对不上）；`confidence` = 众数占比（0–1）。不足两根为 `null`。
- `gaps`：按众数间隔折算 `steps = round(delta / ms)`，`steps > 1` 记一条；`from` / `to` 是第一根 / 最后一根**缺失** K 线的开盘时间（推断值），`missing = steps − 1`；最多 50 条（`opts.maxGaps` 可改），超出给警告。
- `duplicates`：同一 `t` 被丢掉的根数；`ohlcViolations`：`h < max(o,c)` 或 `l > min(o,c)` 的根数。
- `warnings`：表头、坏行、重复、缺口被截断、间隔不是众数倍数、ohlc 违规等都进这里，报告不抛错也不静默。

`normalizeCandleFile(path, outPath)` 输出 `{ "candles": [{t,o,h,l,c,v}, …] }`（升序去重，2 空格缩进，末尾换行），返回输出文件的报告，可直接进 `spec.data.files[].sha256`。

## 测试

```bash
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/data-files
node node_modules/typescript/bin/tsc -p packages/data-files --noEmit
```

用例在 `test/`，全部用 `mkdtempSync` 临时目录、不联网、不读仓库外的真实数据。
