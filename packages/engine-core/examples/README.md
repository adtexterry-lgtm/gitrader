> 许可证：CPAL-1.0。

# examples

**教学示例，无业绩含义。** 它们只演示策略文件和工作流 JSON 怎么写，不是推荐，不随产品的策略列表出现，**默认不加载**。

- `strategies/`：均值回归（布林带）、突破（唐奇安通道）、网格（只做多）、定投、双均线交叉、RSI 均值回归、超级趋势（ATR 通道）、动量（变化率）、马丁加倍（只做多，高风险教学）、均线趋势 + ATR 移动止损。想试就复制进策略文件夹，引擎会校验并热加载。
- `workflows/`：对应的四张 `gitrader-workflow/2` JSON（由 `test/fixtures/workflow-templates.ts` 生成，`test/examples.test.ts` 保证两边一致）。
