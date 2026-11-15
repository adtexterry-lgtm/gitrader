# REPORT-P5.2 · Python 引擎二阶段②：回测接模拟器 + 一致性扩全参数

**做了什么**（只动本包）：`gep.py` 的 `backtest.run` 作业改走 `engine/backtest.py`（`simulator.ts` 逐行移植）。
内置 sma-cross 产目标仓位序列；目录里的 `.py` 策略在子进程新增的 `signals` 作业里整段求值，硬超时
`max(2 s, 15×钩子)` 且被回测上限截断。七个旋钮全部接上：费率（`venue` 问 `host.instruments`，拿不到回落
`0.00045` 并告警）、滑点、资金费（`host.market.fundingHistory`）、强平（维持保证金 + 罚金）、成交量上限走协议
字段；保护与手数归一没有协议字段，走厂商扩展 `spec["x-simulation"]`。`assumptions` 写实际采用值。夹具扩到
20 例覆盖十策略与全参数路径；README 加注册、策略目录、沙箱与限制、回测参数四节。

**验收**（亲跑）：`python -m unittest …/tests/` **351 例全过**（307 旧例无回归 + 44 新例，21 s）；跨引擎一致性
**20 例 / 717 笔成交 / 11 460 个权益点 / 十个策略，最大偏差 0.0**（理由文案 0 处不一致）；`run-conformance.mjs`
**pass 18 / skip 19 / fail 0，O1–O4 pass**（未退步）；`check-public` 临时索引含本包 1 818 文件 0 失败。

**如实**：窗口短于一天时年化收益会溢出（TS 得 `Infinity`，JSON 只能变 `null`），本包报 0 并在 warnings 说明；
改了三处既有断言（权益点 199→200、资金费/强平不再是「不支持」、文件策略回测改为真跑），理由写进测试注释。

**需要主会话决定**：① 是否注册为第二引擎（README 已给 `gitrader.json` 片段与自检顺序）；② 协议
`BacktestSpec` 缺保护/手数/资金费点字段，是否推动加正式字段（现走 `x-simulation`）；③ `__pycache__` 未被根
`.gitignore` 覆盖，跑本包测试会生成（已清），是否补规则。
