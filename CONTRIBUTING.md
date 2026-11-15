# 贡献与施工规矩

## 字段以 protocol 为准

- 一切数据结构（统一交易模型、GEP、插件 / 块 / 工作区清单、授权书、提案、账本、MCP 工具清单）的**唯一出处**是 `packages/protocol`（`schemas/*.json` 与 `src/**/*.ts`），其上游是 M0 契约 v0.1.1。
- **需要新字段，先在 `packages/protocol/CHANGELOG.md` 登记一条，并通知主会话；不许各包私加字段。** 已有字段只追加，不改名、不改语义。
- 契约文件本身不在仓库里改；对契约有疑问，写进 `packages/protocol/OPEN-QUESTIONS.md`。
- 对账级数值（价格、数量、金额、费用、余额、保证金、账本）一律十进制字符串；时间一律整数毫秒。详见 protocol 的 `Decimal` 类型。

## 文件所有权（并行施工边界）

| 代号 | 拥有的包 / 目录 | 消费谁的产出 | 不许碰 |
|---|---|---|---|
| A 契约落码 | 仓库脚手架（根 `package.json`、tsconfig、vitest、`scripts/`、LICENSE 三件）、`packages/protocol/`、`docs/protocol/` | 契约 v0.1.1 | 其他包的实现 |
| B 内核 | `packages/kernel/`（不含连接器）、`packages/cli/` | protocol | UI、引擎、连接器 |
| C 连接器与模拟场所 | `packages/connector-hyperliquid/`、`packages/venue-paper/`、`fixtures/` | protocol、kernel 的连接器总线接口 | kernel 其他文件 |
| D 引擎 | `packages/engine-core/`、`bench/engine/` | protocol（GEP）、一致性测试 | kernel、UI |
| E Agent 接口 | `packages/mcp/`、kernel 里 `api/` 子目录 | kernel 服务接口、protocol MCP 工具清单 | UI |
| F 工作台壳 | `packages/blocks-sdk/`、`packages/workbench/`、视觉系统搬运 | protocol 事件与查询契约 | 默认块实现、内核 |
| G 默认块 | `packages/blocks-default/`、`packages/plugin-template/` | blocks-sdk、API | 壳、内核 |
| H 集成验收 | `docs/`（安全模型、性能基准、配置参考）、`scripts/verify/` | 全部 | 不重写他人模块 |

需要动别人的文件才能完成任务：不要越界改，写进回报"需要主会话决定"。

## 许可与文件头

- 仓库两个许可证：产品本体是 **CPAL-1.0**（开源，界面须显示 Powered by Gitrader，见根 `LICENSE`）；`packages/protocol`、`packages/blocks-sdk`、`packages/plugin-template` 是 **Apache-2.0**（可自由嵌入）。每个包的 `package.json` 的 `license` 字段与其目录内的 `LICENSE` 文件与此一致。
- 源码文件第一行：`SPDX-License-Identifier: CPAL-1.0`（接口包 `protocol` / `blocks-sdk` / `plugin-template` 用 `Apache-2.0`；JSON Schema 在 `$comment` 里写同样的标识）。
- 贡献用 **DCO**（Developer Certificate of Origin 1.1，<https://developercertificate.org>）：每个提交带 `Signed-off-by: 姓名 <邮箱>`，表示你有权按该文件所在包的许可证（产品本体 CPAL-1.0；接口包 Apache-2.0）提交这段代码。不需要签 CLA。

### DCO 怎么做、怎么查

- 提交时加 `-s`：`git commit -s -m "..."`（可以一次性配置：`git config format.signoff true`）。
- 漏签了：最后一个提交 `git commit --amend -s --no-edit`；多个提交 `git rebase --signoff <base>`，然后 `git push --force-with-lease`（只对你自己的 PR 分支）。
- 检查：`.github/workflows/dco.yml` 对每个 PR 里的每个非合并提交检查 `Signed-off-by: 姓名 <邮箱>` 行，缺了就失败；维护者把它设为 `main` 的必需状态检查（`Signed-off-by`）。不依赖第三方 App。
- 提交邮箱用你愿意公开的那个（GitHub 的 `<id>+<name>@users.noreply.github.com` 即可）。

## 约定

- 包名 `@gitrader/<目录名>`；包间引用走 workspace（`"@gitrader/protocol": "*"`），源码直接 `import ... from '@gitrader/protocol'`（包的 `exports` 指向 `src/index.ts`，由 vitest / esbuild 直接消化）。
- 测试放各包 `test/`，运行 `npm test -w packages/<包>`；类型检查 `npm run typecheck -w packages/<包>`。
- 构建用 `node scripts/build.mjs [包名…]`；包在自己的 `package.json` 里声明 `gitrader.build`。
- 第三方依赖只加施工总单清单内的；要加别的先回报主会话。
- 测试端口避开 8765 / 8188 / 9872 / 9222 / 8080 / 5198 / 4184 / 14609 / 47831；测试实例用 `GITRADER_HOME` 指到独立临时目录，不写日常实例目录；只按自己记录的 PID 收尾，绝不按进程名结束进程。
- 不出现邮箱、密钥、IP；产品文案遵守契约附录 B 的对外禁用词。

## 公开发布后的规矩

- **三条自检**（PR 模板里逐条勾；`node tools/release/verify-public-readiness.mjs` 也会检查模板在位）：
  1. **零承诺语言**：产品文案（README、`docs/`、插件与块清单的 name / desc、帮助文本）不写收益、不写任何形式的保证或确定性表述，也不写「即将支持」这类对未来版本的承诺。禁词清单以 `scripts/check-public.mjs` 里的表为准（`node scripts/check-public.mjs` 会扫）；协议侧还可调 `findPromiseLanguage`（`packages/protocol/src/plugin/manifest.ts`）。
  2. **不改协议冻结字段**：`packages/protocol/schemas/*.json` 与 `src/**` 里已经发布的字段名、类型、枚举、错误码不改名、不改语义、不删除；新增字段先在 `packages/protocol/CHANGELOG.md` 登记一条，只追加。
  3. **测试只增不减**：不删除用例、不 `.skip` / `.todo`、不弱化既有断言。行为变了就改期望值并在 PR 里写清为什么；确实要少一个用例，在 PR 的「Not covered / risks」里写原因。
- **CI 跑什么**（`.github/workflows/ci.yml`）：`npm ci` → `npm run typecheck` → `npm test` → `node scripts/check-public.mjs` → `npm run check:schemas -w packages/protocol` → `node ops/verify-ops.mjs` → `node docs/user/verify-docs.mjs` → `node tools/release/verify-public-readiness.mjs` → 构建 → 第三方声明与打包清单。矩阵是 Node 22 / 24（Linux）加一格 Windows / Node 22。本地等价命令逐条跑一遍再提 PR。
- **提交信息**：一行说清做了什么，前缀用 `feat` / `fix` / `docs` / `chore` / `refactor` / `test` 之一，后面括号里写范围（如 `feat(kernel):`）。多个不相关的改动拆成多个提交。
- **变更记录**：用户可见的改动写进根 `CHANGELOG.md`（按日期分组，一条一行，写事实，不写评价）；协议字段的变更另记 `packages/protocol/CHANGELOG.md`。
- **发布与安装**：三种安装方式（便携包、Docker、npm / 源码）见 README 的「安装与文档」；发布前的勾选清单在 `docs/release-checklist.md`。
- **安全问题**：不要开公开 issue，走 `SECURITY.md` 里的渠道；威胁模型与保证 / 不保证在 `docs/security.md`。
