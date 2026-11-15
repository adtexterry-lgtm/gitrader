# Gitrader × UNIGIT（薄适配）

UNIGIT 只是把 Gitrader 当"智能应用 + 工具"装起来：本目录是配方，不含业务逻辑。

> English summary: this directory holds the recipes that let UNIGIT install Gitrader as an app (workbench in a side panel) plus an MCP tool server. It contains no business logic. The agent token is never written into a recipe: create an agent key in Gitrader with host `unigit` and the MCP server reads the token file in the data directory on every call. The rest of this page is maintainer notes (packaging, checks, open items) and is in Chinese.

| 文件 | 说明 |
|---|---|
| `official.gitrader.json` | app 配方：`{node} bin.js serve --port {port:http} --home {dataDir} --static {installDir}/workbench`，右侧栏 iframe 打开工作台，`dependencies` 带上 MCP 配方 |
| `official.gitrader-mcp.json` | mcp-tool 配方：`{node} gitrader-mcp.js`，`GITRADER_HOME` 指向兄弟目录 `apps-data/official.gitrader`（`{dataDir}` = `<appsRoot>/apps-data/<配方id>`），两边通过其中的 `service.json` 互相找到；每个 UNIGIT 实例有自己的 appsRoot，互不串线 |
| `official.gitrader/SKILL.md` | 随配方下发的技能（≤2000 字符，门禁已查） |
| `home-patch-insert.yml` | 不走商店、直接挂进 UNIGIT profile 的写法（也可 `gitrader mcp snippet unigit` 生成带绝对路径的版本） |

## 令牌怎么到 MCP 手里
令牌不写进任何配方。用户在 Gitrader 里创建 Agent 钥匙（宿主选 unigit，令牌只显示一次），把令牌存进 `<数据目录>/agent-unigit.token`；MCP 每次调用时现读这个文件（可以晚于安装创建、可以轮换）。没有钥匙时工具返回"no agent key yet…"，由 SKILL 引导用户去创建。

## 打包与门禁
- `node integrations/unigit/pack.mjs`：把 `packages/cli/dist`（bin.js、engine-core.mjs、workbench/）与 `packages/mcp/dist/gitrader-mcp.js` 打成 `dist-store/` 下的两个 zip（纯 Node 写 zip，固定时间戳，同输入同 sha256），并把真实的 `size` / `sha256` 回填进两份配方。`source.url` 是将要上传的地址，产物一变就要重跑再上传。
- 展示图取自真实运行截图（`reports/H-shots`，1440×900 放大到 1600×1000；hero / cover 取同一批截图的 16:9 裁切），图标是 维护者 的 G 字标原件（`packages/workbench/src/ui/brand/g-glyph-32.svg`，原样复制）。
- 静态校验：UNIGIT 能力插件的 `scripts/check-recipe-data.mjs <id> <kind>`（取自内部验收环境的只读副本，在临时目录里放配方与附件后运行，不起内部宿主实例）。两份配方当前全部通过，不需要 `--allow-placeholder`。verify-kit 本身没有静态配方校验，只有起实例的真装旅程（这一步未做）。

## 待定事项（需要主会话 / 维护者 决定）
1. **嵌入（R8，未能在配方里落地——卡在 UNIGIT 配方体系，不在 Gitrader）**
   - 需求：① 把 UNIGIT 宿主来源写进 `embed.allowedOrigins`；② 应用打开时拿一次性启动链接再加载 iframe。
   - 内核侧：`embed.allowedOrigins` 配置与 CSP / 跨站放行已在（`kernel/src/config.ts`、`http/server.ts`）；但 CLI 的 `config set embed.allowedOrigins`、`open --print --json`、免 PIN 的 `--unattended` 在我检查时还没落地（`cli/src/index.ts` 里没有），现有 `session.link` 要 PIN 加服务令牌，UNIGIT 手里都没有。
   - 配方体系侧（对照 UNIGIT 能力插件的 `recipe.js` / `engine.js`）：占位符只有 `installDir`、`dataDir`、`node`、`recipeDir`、`gateway.*`、`port:`、`secret:`、`capture:`，**没有宿主来源变量**；`configure` 只能发 HTTP（GET / POST / PUT），不能跑命令；`launch` 只能起一个进程；`embed.url` 渲染时 `captures` 是空的（`engine.js` 1742 行），所以不能把 configure 里拿到的链接塞进 iframe。
   - 因此现在只能：`embed.url` 写 `http://127.0.0.1:{port:http}/`（没有会话，iframe 里是"请取新链接"提示页），用户在终端 `gitrader open` 取链接用系统浏览器打开。
   - 要做成，需要两边各补一点：UNIGIT 配方体系加"宿主来源"占位符、让 `embed.url` 能用启动后拿到的值（或让宿主调一个启动钩子）；Gitrader 侧加一个凭"本次启动的 `secret:` 值"才能调用的免 PIN 取链接端点（B 的 `--unattended` 若走这条，配方就能写成：`launch.env` 传 secret、`configure` 调端点并 `capture`、`embed.url` 引用）。等这两处定了再改配方。
2. **商店真装**：未在隔离实例里装过一次（本轮只做静态校验）。
3. 展示图里有验收时的测试文案（如提案备注 "H-J3 …"），上架前可重截一版干净的。

## 首次上手

首次从零安装、接入、提第一单，见上手技能 `gitrader-onboarding`：`integrations/claude-code/SKILL.md`。技能按七步走，人只需要在浏览器输 PIN、在待批里点批准。
