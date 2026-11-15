> 许可证：CPAL-1.0。

# strategy-template

空白策略模板。`strategy.ts` 有完整的接口、参数 schema、理由字段和回测 / 纸面的使用说明，**没有任何交易逻辑**。

1. 复制到 `~/.gitrader/engines/gitrader-core/strategies/<你的-id>.ts`
2. 改 id / name / version / desc / params，实现 `evaluate`
3. 读 `x-gitrader.strategy.files` 看校验结果，改到没有错误
4. `backtest.run` → 纸面 `strategy.start`

文件顶部的注释是写给 Agent 看的（什么能做、什么不能做）。引擎的 README 有完整流程：`../README.md` 的「让你的 Agent 写第一条策略」。
