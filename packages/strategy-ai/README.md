> 许可证：CPAL-1.0。

# @gitrader/strategy-ai

AI 生成策略的离线闭环：**提示词 → 生成 → 静态校验 → 冒烟回测 → 有界修复 → 可读报告**。
模型只从注入的 `Llm` 进来——本包不读密钥、不联网、不打印请求内容，也不认识任何模型供应商。

## 接口

```ts
import { buildPrompt, generate, validate, smoke, repairLoop, explain } from '@gitrader/strategy-ai'

const spec = { intent: 'buy when the short average crosses the long one', style: 'trend', interval: '1h' }

buildPrompt(spec)                          // string：engine-core 的规格 + 本流水线的检查说明
await generate(spec, llm)                  // { code, prompt }：一次生成、去围栏
validate(code)                             // { ok, source, issues }：纯静态，不执行
await smoke(code, candles)                 // 加载校验 + 一次回测的摘要（历史数字）
await repairLoop(spec, llm, { maxRounds: 2 })  // GenerationResult：每轮的代码 / 失败 / 冒烟都在里面
explain(result)                            // Markdown：请求、结果、静态检查、冒烟、每一轮
```

`llm` 只需要一个方法：`{ complete(prompt: string): Promise<string> }`。凭据由调用方自己持有。
抛错或返回空白算一次失败，记进结果的 `stopped: 'llm-error'`，不会伪装成「生成的代码不合格」。

## 复用而不是复制

- 提示词与静态校验来自 `packages/engine-core/src/strategy/ai-generation.ts`（**只读、未修改**）；
  该模块不在 engine-core 的公开导出里，所以按仓库的源码直连方式深路径 import。
- 冒烟用的是 engine-core 自己的加载器与回测：候选源码先落到系统临时目录、跑完即删，
  动态检查（空序列 / 短序列 / 极端参数 / 确定性 / 截断前视）与用户真加载同一份文件时完全一致。

## 修复循环

`repairLoop(spec, llm, { maxRounds })`：首轮不合格时，把上一版完整代码 + 逐条失败（规则名 / 行号 / 原话）
拼成修复提示词再问一次，最多 `maxRounds` 轮（缺省 2，允许 0；超过 8 按 8 计）。静态检查通过才进冒烟；
冒烟失败的错误同样原样喂回。缺省冒烟数据是 `defaultSmokeCandles()`：engine-core 合成 K 线 400 根（固定 seed）。
每一轮都进结果，`explain` 只读结果，所以报告里的数字与失败原因都是真跑出来的。

## 测试

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/strategy-ai
node node_modules/typescript/bin/tsc -p packages/strategy-ai --noEmit
```

全部离线：假 client 按脚本回答（合法 / 非法 / 带 import / 抛错 / 空白），K 线是确定性锯齿序列。
`explain` 的输出过 protocol 的 `findPromiseLanguage`，报告里没有任何关于以后的数字或说法。
