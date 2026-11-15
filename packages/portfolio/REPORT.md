<!-- SPDX-License-Identifier: CPAL-1.0 -->
# REPORT · T4 组合分析 `packages/portfolio`

## 一、做了什么

新建 `packages/portfolio`：注入价格源的跨场所估值、资产/场所/标的/方向敞口、策略/场所/标的的盈亏归因、HHI 集中度。记账用协议 18 位定点、对外 8 位，零第三方依赖。

## 二、关键决定

① 缺价不兜底：QD 写 0 继续汇总，本包报错列全或 opt-in `skip` 记入 `unpriced`——当 0 会让敞口与集中度静默失真。② 未实现盈亏用注入价重算，场所值另存 `venueUnrealizedPnl`、差额 `drift` 可对账。③ 集中度用绝对敞口：多空各 100、净敞口 0，用净敞口会误判「完全不集中」。④ `inverse` 结算与三角汇率拒绝。

## 三、反证记录

四处改坏（明细见下表）分别红 4 / 3 / 2 / 2 例；均字节还原、`diff` 空、恢复后 58/58 绿。

## 四、没做 / 待定

余额/权益/保证金/手续费不在本包（只算持仓侧）；未登记 lock、未进 CLI/内核、未提交；自查 S2/S3/S4/S6/S7/S15 不适用。

---

## 验收（仓库根，亲跑粘贴）

```
$ node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/portfolio
 Test Files  6 passed (6)
      Tests  58 passed (58)

$ node node_modules/typescript/bin/tsc -p packages/portfolio --noEmit
tsc_exit=0
```

## 反证明细（故意改坏 → 变红 → 恢复）

| # | 改坏的地方 | 变红的用例 | 结果 |
|---|---|---|---|
| M1 | `src/valuation.ts`：`unrealized` 去掉空头分支（空头符号被抹） | 空头永续：按 contractSize 折基础数量，浮盈方向取反／三笔跨三场所…／四块报表在同一份合成数据上互相自洽／归因总额 = 已实现 + 未实现 + 资金费 | 4 failed \| 54 passed |
| M2 | `src/valuation.ts`：缺价改判为「通过」，价格 0 参与汇总（即 QD 的做法） | 缺价缺省报错，并列出全部缺价标的（不静默当 0）／onMissingPrice: 'skip' 只跳过缺价那笔…／价格返回 0 按缺价处理 | 3 failed \| 55 passed |
| M3 | `src/concentration.ts`：`absoluteExposure` 改回带符号敞口 | 同一标的多空各 100：净敞口为 0，但集中度必须是「全压一个标的」／四块报表… | 2 failed \| 56 passed |
| M4 | `src/valuation.ts`：`markValuation` 忽略汇率（乘 1） | 报价币与计价币不同：按注入汇率折算每个金额字段／只给反向汇率对时取倒数 | 2 failed \| 56 passed |

恢复方式：`cp` 备份覆盖 → `diff -q` 两份无差异 → `grep -rn MUTANT src/` 无命中 → 复跑 58/58 绿。备份目录已删，无残留。

## 自查表 v2

| # | 检查项 | 判定 | 证据（命令 → 输出摘录） |
|---|---|---|---|
| S1 | 对照参照独立来源 | 过 | `grep -rn QuantDinger README.md src/` → `README.md:10`、`src/valuation.ts:3`：QuantDinger `services/portfolio/{positions.py,pricing.py}`（Apache-2.0），只列借鉴的语义（price_map 注入 / market_value / cost_value / pnl / 按市场聚合），代码本仓库重写 |
| S2 | 端点 / 错误码以官方文档为准 | 不适用 | 本包无 HTTP 端点、无场所错误码（`grep -rn "fetch\|http" src/` 无输出） |
| S3 | 假服务器按参照规则实现 | 不适用 | 无假服务器 |
| S4 | 碰钱脚本拦实盘护栏 | 不适用 | 无碰钱脚本 |
| S5 | 遇安全闸门停报不绕 | 不适用 | 无安全闸门相关代码 |
| S6 | 沙箱逃逸反例 | 不适用 | 无沙箱 |
| S7 | 子进程治理 | 不适用 | 无子进程；收工 `find packages/portfolio -type f` 只有源 / 测试 / README / 两个 json |
| S8 | 注释声称与实现一致 | 过 | `grep -rn "MUTANT\|TODO\|FIXME" src/ test/` → 无输出；`unsupported_settlement`、`missing_price` 分支与头注释声称的拒绝项逐一对应（`grep -n "unsupported_settlement\|missing_price" src/valuation.ts`） |
| S9 | 验收扫描覆盖新文件 | 过 | 新文件未入库、`git ls-files` 扫不到，故按 check-public 同规则单扫四项（本机路径 / 产品文案禁词 / 邮箱 / SPDX 首行）：四项均无命中，输出见下方「单扫输出」 |
| S10 | 待办前查过 git 现状 | 过 | `git log --oneline -1` → `c1c8665`；`git status --porcelain packages/portfolio` → `?? packages/portfolio/`（新包，未入库，符合边界） |
| S11 | 无临时文件、无无意义改动 | 过 | `git status --porcelain` 里本标段只有 `?? packages/portfolio/` 一行；未触碰其它文件；反证备份在 scratch 已删 |
| S12 | REPORT 四段 + 数字真实 + 借鉴附出处 | 过 | 本文件；验收命令输出为粘帖原文；借鉴清单见 README「设计参照」 |
| S13 | 修复任务对照原审稿 | 不适用 | 不是修复任务 |
| S14 | 边界穷举 | 过 | 用例清单：缺价 / 零价 / 缺汇率 / 汇率 0 与负 / 未知标的 / inverse / 重复持仓 / size 0 / 多空对冲 / 空组合 / 同值排序 / 尾随零 / 1÷3 截断 / 注入价覆盖 Position.markPrice（见 `test/*.test.ts`） |
| S15 | 读失败不触发动钱动作 | 不适用 | 本包无下单 / 平仓 / 撤单路径：`grep -rnE "order\|cancel\|close" src/` → 无输出；缺价与缺数据一律抛 `PortfolioError` |
| S16 | 每条「过」有命令与输出 | 过 | 见本表各行；无「凭印象」项，判不了的写不适用 |

## 文件

`src/`: `decimal.ts` `types.ts` `valuation.ts` `exposure.ts` `attribution.ts` `concentration.ts` `analysis.ts` `index.ts`；`test/`: `factories.ts` + 6 个 `*.test.ts`；`README.md`、`package.json`、`tsconfig.json`、本文件。

## 单扫输出（check-public 同规则，覆盖未入库新文件；正则字面量省略，避免把禁词写进仓库文本）

```
$ grep -rnE '<本机路径模式>' packages/portfolio --include='*.ts' --include='*.md' --include='*.json'
none
$ grep -rnE '<六条产品文案禁词>' packages/portfolio/src packages/portfolio/README.md
none
$ grep -rnE '<邮箱模式>' packages/portfolio --include='*.ts' --include='*.md'
none
$ for f in $(find packages/portfolio/src packages/portfolio/test -name '*.ts'); do head -1 "$f" | grep -q 'SPDX-License-Identifier: CPAL-1.0' || echo "MISSING $f"; done
headers-checked
```

## 收口修复（批 9 收口）

- B1：`src/valuation.ts:151` 按 `venueSizeUnit` 折基础数量（`'contract'` 乘 `contractSize`，`'base'` 不乘）；工厂补标：`test/valuation.test.ts:11-12`、`test/analysis.test.ts:19`、`test/hand-calc.test.ts:20,42`；新增两例 `test/valuation.test.ts:118-153`。
- S1：`src/types.ts:57-63` 注释写明实际三种 `code` 口径；`README.md:49-53` 同口径改写。
- S2：`README.md:38` 名义敞口行、`README.md:45` 精度行、`README.md:66` 用例数。
- 反证：改回「一律乘 `contractSize`」→ `1 failed | 63 passed`（`venueSizeUnit: 'base'` 新例红）；改成「一律不乘」→ `9 failed | 55 passed`（跨场所合计 / 空头永续 / 两组手算 / 新 contract 例等红）；两次均恢复。
- 实跑：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/portfolio` → `Test Files 7 passed (7)`、`Tests 64 passed (64)`；`node node_modules/typescript/bin/tsc -p packages/portfolio --noEmit` → `tsc_exit=0`。
