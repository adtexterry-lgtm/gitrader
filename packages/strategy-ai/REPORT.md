# P2 · AI 生成策略流水线（packages/strategy-ai）

**改了什么**：新建 `packages/strategy-ai/`（8 源文件 + 6 测试 + README/LICENSE/package.json/tsconfig）。六接口：`buildPrompt`/`generate`/`validate`/`smoke`/`repairLoop`/`explain`。提示词与静态校验直接复用 engine-core 的 `strategy/ai-generation.ts`（只读未改；该模块不在公开导出里，按源码直连深路径 import）。冒烟用 engine-core 自己的加载器 + 回测：候选码落系统临时目录、跑完即删，动态检查与用户真加载同一份文件一致。修复循环缺省 2 轮、可配 0–8，每轮代码/失败/冒烟都进结果；`explain` 只读结果，零承诺语言。模型只从 `Llm` 注入，包内无厂商名（有测试守）。

**跑了什么**：6 文件 35 例全过（合法 / 非法 / 带 import 三形态假 client；断言轮数、`exhausted`、`llm-error`、冒烟错误回灌、`findPromiseLanguage(explain(...)) === null`）；`tsc -p packages/strategy-ai --noEmit` 退出 0；`protocol hygiene` 6/6；`check-public.mjs` 通过。

**没做什么**：不做补丁式代码编辑（取舍理由见 repair.ts 注释）；不接内核、不写工作台、不做 CLI；不联网、不装依赖、不碰既有文件。

**需要主会话决定**：①engine-core 未导出 `ai-generation`，本包用深路径 import；若把它升为公开导出，本包改成具名导入即可。②`explain` 的正文是中文，若将来要随英文文档发布需一份 en 版本（与本批次主题五同批处理更省事）。
