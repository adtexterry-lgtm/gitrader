<!-- SPDX-License-Identifier: CPAL-1.0 -->
# 协议文档

协议的唯一出处是 `packages/protocol`：

- 类型：`packages/protocol/src/`
- JSON Schema：`packages/protocol/schemas/`（`$id` 形如 `urn:gitrader:schema:model:0.1:Order`、`urn:gitrader:schema:gep:0.1:Methods`、`urn:gitrader:schema:plugin:1`）
- 变更记录与字段登记：`packages/protocol/CHANGELOG.md`（任何新字段先在此登记）
- 契约疑点与已决事项：`packages/protocol/OPEN-QUESTIONS.md`
- GEP 一致性测试套件：`packages/protocol/conformance/README.md`

写第二个引擎实现（任何语言）：读 GEP 的方法清单（`src/gep/methods.ts`）与 `engine.describe` 结构，用 `schemas/gep.*.json` 校验自己的输入输出，然后对着一致性套件跑：

```
GEP_LAUNCH='{"command":"<你的可执行文件>","args":["--gep","stdio"]}' npm run conformance -w packages/protocol
```

规范正文（对外发布的 `spec/` 目录）在发布阶段由契约文档拆出，本目录先作索引。
