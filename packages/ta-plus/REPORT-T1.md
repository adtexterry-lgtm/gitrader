# REPORT-T1 · ta-plus 收尾（批 9 主题一）

## 一、做了什么

1. **9 处语义重复**：`plusDI` / `minusDI` 转发 `adx()`，`aroonOsc` 转发 `aroon().osc`，`linRegSlope` / `linRegIntercept` 转发 `linearRegression()`；包内第二套 Wilder / 回归实现（`diPair`、`trueRanges`）删除，`dx` 改由转发的两条 DI 合成。engine-core 的 `exports` 只有 `.`、根入口不 re-export `ta/`，本批又不许改它，故按相对路径只读引用（`packages/strategy-ai` 有同法先例）；转发前仍 `assertPeriod`，不吃它「非法周期返回全 null」的宽口径。
2. **口径不同的 4 个**（`adOsc` / `stochF` / `correl` / `variance`）保留本身实现，README 新增差异表：EMA 种子、区间为 0 的兜底（0 vs 50）、输入形状与 null 窗口、方差 vs 标准差，每条各配「改任一边就红」的用例。
3. 删 `tradingLevels`：源码、两个类型、导出、4 条测试、性能表行、README 行。
4. **非法周期统一抛错**：新增 `period-errors.test.ts`，40 个入参组合（39 个导出）× 5 类非法值（0 / 负数 / 小数 / NaN / Infinity），另点名命名参数、回归 `period ≥ 2`、`variance` 的 `ddof`。
5. **口径复核**：方向类 / NATR / BETA 三段重写。本包一侧与夹具逐位一致；README 里「TA-Lib 的数值」标明是批 8 收口按源码复算、本批未联网重读。基本面入参标「实验性」。

## 二、怎么验的

- `vitest --root packages/ta-plus`：**18 文件 / 162 例全绿**（改前 16 / 150；删 4 例 tradingLevels、新增 16 例）。
- `tsc -p packages/ta-plus --noEmit`：**退出 0**（无输出）。
- 反证①把 `internal.ts` 的 `assertPeriod` 判断删空 → **10 文件 14 例红**（period-errors 5 条全红），恢复后 `git diff` 为空。反证②把 `plusDI` 故意转发成 `adx().minusDi` → **6 例红**（含 parity 逐位比对），已恢复。

## 三、边界与留给主会话

- 只改 `packages/ta-plus/`；没碰 engine-core，没动 `package.json`（所以无 lock 变更）。转发走相对路径，若要求正式登记 workspace 依赖，需与 lock 一起改。
- `REPORT.md` / `REPORT-T1b.md` 是已交付的历史记录，仍含 `tradingLevels` 行，未改（不篡改记录）；`REPORT-T1b.md` 性能表里 5 个转发指标的耗时随之变化，本次未复测填新数。
- 未联网、未 install、未提交；收工无临时文件、无后台进程。

## 四、自查表（v2）

| # | 检查项 | 判定 | 证据（命令 / 文件 + 输出摘录） |
|---|---|---|---|
| S1 | 参照独立来源 | 过 | 转发源=engine-core（同仓库，README 明示「不算独立参照值」）；外部参照=TA-Lib 源码 commit `1da0e86bb6c5` + QD `registry.py`。README「参照与出处」标了口径归属（哪些数是批 8 复算、本批未重读） |
| S2 | 端点/错误码以官方文档实查 | 不适用 | 纯函数库，无端点、无错误码、无网络 |
| S3 | 假服务器按参照规则实现 | 不适用 | 无网络交互，无假服务器（`grep -rn "fetch\|http" src` 无命中） |
| S4 | 碰钱脚本护栏 | 不适用 | 无碰钱代码 |
| S5 | 遇安全闸门停报不绕 | 不适用 | 无安全闸门；周期校验是输入校验，有 7 条用例 |
| S6 | 沙箱逃逸反例 | 不适用 | 无沙箱 / 无动态求值 |
| S7 | 子进程治理 | 过 | `grep -rnE "child_process\|spawn\(\|execFile" src test \| wc -l` → `0`；收工 `git status` 无残留 |
| S8 | 注释 / 文件头声称与实现一致 | 过 | `grep -rn "from '../../engine-core" src/*.ts` → 3 行 import（directional/osc-ext/regression），与注释点名的转发函数一一对应；9 条 parity 用例证明语义 |
| S9 | 扫描覆盖新文件 | 过 | 按 `scripts/check-public.mjs` 同规则（禁词 / 本机路径 / 邮箱）用一个 12 行清单单扫改动+新增文本文件 → `ok 12/12`（未入库文件 check-public 的 `git ls-files` 扫不到，故手工同规则扫） |
| S10 | 待办前查 git log 与 CLOSE | 过 | `git log --oneline -3 -- packages/ta-plus` → `fb30877`（T1a+T1b 已提交）；`CLOSE-B8-data.md` 记 阻断 4 / 应修 3、`tradingLevels` 归属待决 → 本批按裁定删除 |
| S11 | 无临时文件、无无意义改动 | 过 | `git status --porcelain packages/ta-plus` → 8 改 + 3 新增（REPORT-T1.md、两个新测试），全在包内；`internal.ts` 反证后 `git diff` 为空；无 `zz-*.test.ts` |
| S12 | 四段式 + 数字真实 | 过 | 本报告数字均来自本节所列命令的实跑输出 |
| S13 | 对照原审稿逐条核对 | 过 | ①循环自证→标口径归属 ②测试区分力→两条反证 ③「已验证」覆盖→不再声称本批验证 TA-Lib ④自评乐观→本表逐项证据 ⑤待定先做→`tradingLevels` 已删 ⑥小错→本包无禁词 / shebang 类问题（S9 扫描） |
| S14 | 状态机 / 撮合边界 | 不适用 | 无状态机、无撮合 |
| S15 | 读失败分支不触发动钱 | 不适用 | `grep -rniE "placeOrder\|cancelOrder\|closePosition\|市价全平" src \| wc -l` → `0` |
| S16 | 每条「过」附命令与输出 | 过 | 本表每行均给命令或文件证据；无证据项一律标「不适用」 |
