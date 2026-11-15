> 许可证：CPAL-1.0。

# tools/release · 发布卫生

首发与 CI 用的发布卫生脚本。四个脚本各自独立、各自退出码：**0 = 通过，1 = 有失败项**（逐条打印原因）。
全部只用 Node 标准库，离线运行（唯一例外是 `pack-dry-run.mjs` 会调本机 `npm pack --dry-run`，不联网、不写 tarball）。

```bash
node tools/release/audit-headers.mjs      # 首行 SPDX 与包许可证一致
node tools/release/pack-dry-run.mjs       # npm 产物只含允许文件、入口齐全
node tools/release/deps-audit.mjs         # 运行时依赖只有工作区包与白名单
node tools/release/verify-public-readiness.mjs   # 发布面结构（模板、根文档、CI 命令可解析）
node --test tools/release/test/           # 三脚本的验收用例（30 例）
```

## 1. audit-headers.mjs

`node tools/release/audit-headers.mjs [--root DIR] [--baseline FILE]`

- 受版本控制的源码（`.ts/.tsx/.mts/.cts/.mjs/.cjs/.js/.jsx/.py`；`.d.ts/.d.mts/.d.cts` 类型声明豁免）
  **第 1 行**必须是 `// SPDX-License-Identifier: <ID>`（Python 用 `#`），写在第 2 行也算失败。
- `<ID>` 必须等于最近的带 `license` 字段的 `package.json` 的 `license`；没有包声明的目录（`tools/`、`scripts/`、
  `ops/`、`docs/`、`integrations/`、`assets/`）取根 `package.json`。只认 `CPAL-1.0` 与 `Apache-2.0`。
- 根 `LICENSE` 必须是 CPAL-1.0 原文 + Exhibit A/B（标题行、第 1 节、第 15 节、Exhibit B 归属短语
  `Powered by Gitrader`、词标路径 `assets/brand/gitrader-wordmark.svg` 全在，长度像全文）；根 `package.json`
  的 `license` 必须是 CPAL-1.0；`NOTICE` 必须逐个列出 Apache-2.0 的包；每个 Apache-2.0 的包自带 Apache 2.0 全文
  `LICENSE`；真仓库必须存在 `@gitrader/protocol` 且为 Apache-2.0。

### 历史例外基线 `spdx-baseline.json`

`entries[]` 每条是 `{path, kind: missing|mismatch, reason}`。**只准缩小**：

- 基线里没有的违规 → 失败（新文件不许无首行 SPDX）；
- 基线登记了但文件已修好 / 文件不存在 → 也是失败（必须删条目，防止基线变成永久豁免）；
- `kind` 必须与实际的违规种类一致（缺首行 ≠ 许可证不一致），`reason` 不许空。

当前 21 条，其中 **4 条是真问题、需要主会话补一行**（`packages/cli/src/bin.ts`、`packages/engine-core/test/helpers.ts`、
`packages/plugin-template/example/ema-reading/block.js`、`packages/workbench/design/audit-probe.js`），
1 条是许可证写错（`packages/protocol/test/p3.test.ts` 首行 CPAL-1.0，包是 Apache-2.0），
其余 16 条是 `assets/` 与 `integrations/` 下的物料渲染脚本和 `verify/.tmp` 临时产物。

## 2. pack-dry-run.mjs

`node tools/release/pack-dry-run.mjs [--root DIR] [--input FIXTURE.json]`

对每个带 `files` 字段的工作区包跑 `npm pack --dry-run --json --ignore-scripts`（不跑 `prepack`，审计不改工作区），
按 `scripts/check-public.mjs --pack` 的口径逐包校验：

- **允许**：`files` 字段点名的路径 + npm 自动包含的 `package.json` / `README.md` / `LICENSE` / `NOTICE` /
  `THIRD-PARTY-NOTICES.md`；`dist/` 下的产物（含 `*.LEGAL.txt` 与 `*.d.ts`）。
- **禁止**：source map、点文件、`test|tests|__tests__|spec|fixtures|verify|reports|before-r1|node_modules|src|coverage|.tmp`
  目录、`CHANGES.md`、`.tgz`、`.env`、`package-lock.json`、`dist/` 之外的 `.ts/.py/.sh/.yml`。
- **必需**：`package.json`、`README.md`、`LICENSE`；`package.json` 的 `bin/main/module/types/exports`
  指向的每个文件都要在产物里；`files` 点名的路径不能一个文件都没进包。

`--input` 吃离线夹具（`{package, files:[...]}` 或数组），测试走这条路，不碰 npm。
`packages/cli/dist` 不存在时（干净检出、尚未构建）会如实失败：CI 里这一步排在 Build 之后。

## 3. deps-audit.mjs

`node tools/release/deps-audit.mjs [--root DIR] [--whitelist FILE]`

- `dependencies` / `optionalDependencies` / `peerDependencies` 只能是工作区包（版本写 `*`）或
  `deps-whitelist.json` 里的第三方包，且版本字符串必须命中该条目的 `ranges`。
- 名字像工作区包（`@gitrader/*`）但工作区里没有 → 失败（拼错 / 幽灵依赖）；包依赖自己也失败。
- `devDependencies` 里的 `@gitrader/*` 同样必须是真实工作区包（第三方 devDeps 是本地构建工具，不随包发布，只列不判）。
- 白名单条目必须被用到（过期条目失败）且必须写 `reason`。

当前 38 个工作区包，第三方运行时依赖 12 个名字 / 16 处引用，全部在白名单里（`ajv`、`ajv-formats`、`ws`、
`@types/ws`、`@noble/curves`、`@noble/hashes`、`@nktkas/hyperliquid`、`@modelcontextprotocol/sdk`、
三个 `@radix-ui/*`、`preact`）。

## 4. 测试

`node --test tools/release/test/`：30 例，其中 4 例是**真仓库现状**（三脚本各跑一次 + LICENSE 原文自查），
其余 26 例是在临时目录里搭夹具、跑真脚本、断言退出码与报错文本（坏 SPDX / 缺首行 / 基线过期 / LICENSE 不全 /
source map / 未登记依赖 / 版本越界 / 白名单过期 …）。夹具全在 `mkdtemp` 出来的目录里，用完删除，不写仓库、不联网。
`tools/release/test/package.json` 的 `main` 指向 `index.mjs`，让「目录参数」在 Node 22.23.2 上等价于跑全部用例
（与 `tools/research/test/`、`tools/bench/test/` 同一套做法）。
