<!-- SPDX-License-Identifier: CPAL-1.0 -->
# @gitrader/stats

回测统计的纯函数库：零依赖，输入输出都是 JS `number`（收益序列、统计量），不是账本金额。

- `dist.ts`：均值 / 方差 / 偏度 / 峰度、每期夏普与年化、正态 Φ 与 Φ⁻¹、PSR（Probabilistic Sharpe Ratio）、DSR（Deflated Sharpe Ratio）与 N 次试验最大夏普期望。
- `splits.ts`：purged K-fold（带标签 horizon 与 embargo）、walk-forward 窗口、组合枚举。
- `pbo.ts`：CSCV 回测过拟合概率（PBO）、样本外退化直线、样本外亏损概率。
- `bootstrap.ts`：循环块自助法与可复现随机数（mulberry32）、百分位分位数。

口径：夏普一律「每期」，年化只在 `annualizeSharpe` 里做；偏度 / 峰度为总体口径，峰度非超额（正态 = 3）；所有区间为半开 `[start, end)`。

出处：Bailey & López de Prado, *The Sharpe Ratio Efficient Frontier* (2012)；Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014)；Bailey, Borwein, López de Prado & Zhu, *The Probability of Backtest Overfitting* (2014)；López de Prado, *Advances in Financial Machine Learning* (2018) ch. 7（purged K-fold / embargo）。
