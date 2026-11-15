# 首发清单（给 维护者）

按顺序勾选。`<org>/<repo>` 是占位，名字定了再替换。命令在仓库根目录执行，Node >= 22.13。

## 0. 先清理仓库内容（推到 GitHub 之前）

- [ ] **内部施工记录不进公开仓库**（已定：用 `.gitignore` 排除，文件留在本机，不搬动——验收脚本的产物目录就是 `reports/`）：`before-r1/`、`packages/*/before-r1/`、`reports/`、`dist-store/`、`packages/*/CHANGES.md`、`packages/*/test-out/` 已写进 `.gitignore`。新仓库的首个提交用 `git add .`（不要 `-f`），然后 `git ls-files | grep -E "before-r1|reports/|dist-store|CHANGES.md"` 必须没有输出；`node scripts/check-public.mjs` 同样会检查（CI 里也跑）。
  - 想保留这些记录的人：它们仍在本机目录里，可另存到仓库外（例如 `gitrader-internal/`）；公开文档里引用 `reports/...` 的地方（如 `docs/perf-baseline.md`）写的是"运行脚本重新生成"，不是链接。
  - npm 包不受影响：`packages/cli` 的 `files` 是白名单，只含 `dist/` 与随包文档。
- [ ] `node scripts/check-public.mjs` 通过（本机路径、产品文案禁词、邮箱、内部记录）。
- [ ] 确认 `THIRD-PARTY-NOTICES.md`、`packages/cli/NOTICE`、`packages/cli/THIRD-PARTY-NOTICES.md` 是刚生成的（见第 2 节）。
- [ ] 确认 `packages/cli/package.json` 的 `version` 就是要发的版本（现为 `0.1.1`；根包 `gitrader-monorepo` 是 private，版本号不影响发布）。

## 1. GitHub 组织与仓库

- [ ] 注册 / 选定 GitHub 组织（两步验证开启，至少两位 owner，避免单点）。
- [ ] 创建仓库 `<org>/<repo>`，公开，不勾选自动生成 README / LICENSE（本仓库已有）。
- [ ] 仓库设置 → Branches：给默认分支 `main` 加保护规则（合并需 PR、需通过状态检查、禁止强推、禁止删除）。
- [ ] 必需状态检查：`main` 的保护规则里把 CI 的三格（`ubuntu-latest / Node 22`、`ubuntu-latest / Node 24`、`windows-latest / Node 22`）和 DCO 的 `Signed-off-by` 设为必需。工作流在 `.github/workflows/`（`ci.yml`、`dco.yml`，不依赖第三方 App；DCO 的做法见 `CONTRIBUTING.md`）。
- [ ] Issue / PR 模板已在 `.github/`（bug、功能建议、PR 清单）。**把 `.github/ISSUE_TEMPLATE/config.yml` 与根 `README.md` 里的 `<org>/<repo>` 换成真实名字**，并取消 README 里 CI 徽章的注释。
- [ ] Settings → Security → 打开 **Private vulnerability reporting**（Security Advisories）。
- [ ] 确认根目录 `SECURITY.md` 已在仓库里（已写实：只走 GitHub 私密漏洞报告，不留邮箱；首次回应 72 小时、修复窗口 90 天）。
- [ ] 推送首个提交（本清单所在会话不提交不推送，由你来）。

## 2. 发布前本地检查

- [ ] `npm install`（根目录，工作区一起装）
- [ ] `npm test`（浏览器用例需要本机 Edge 或 playwright-core，可用 `GITRADER_EDGE` / `GITRADER_PLAYWRIGHT` 指过去；确实没有就设 `GITRADER_SKIP_BROWSER=1`，并在发布说明里如实写「浏览器用例未跑」）
- [ ] `npm run typecheck`
- [x] **CPAL-1.0 署名检查（Exhibit B）**：三件套为 `Powered by Gitrader`、`assets/brand/gitrader-wordmark.svg` 与项目链接。位置：关于页；启动 / 连接中的骨架页与会话失效卡底部（`packages/workbench/src/shell/Attribution.jsx`，由 `Shell.jsx` 挂载）。主页面不另加角标（ADR-11）。
- [ ] `node scripts/build.mjs --notices`（重新生成 `THIRD-PARTY-NOTICES.md`；检查里面没有非 OSI 许可、没有新增的意外依赖）
- [ ] 先确认 `packages/*/dist` 不是旧产物（它可能落后于源码；发布一律以从当前源码新构建为准）。`npm pack -w packages/cli`（会触发 `prepack` 构建，生成 `gitrader-0.1.1.tgz`；或用 `npm run pack:release -- --skip-portable`，产物进 `dist-release/`）。看清单应只有：`LICENSE`、`NOTICE`、`README.md`、`THIRD-PARTY-NOTICES.md`、`package.json` 和 `dist/`（`bin.js`、`bin.js.LEGAL.txt`、`engine-core.mjs`、`gitrader-mcp.js`、`workbench/` 下 4 个文件）；不应出现 `test/`、`*.map`、`before-r1`、本机路径。
- [ ] 记下校验和：`sha256sum gitrader-0.1.1.tgz`（Git Bash）或 PowerShell `Get-FileHash gitrader-0.1.1.tgz -Algorithm SHA256`。
- [ ] 删除生成的 `gitrader-0.1.1.tgz`（`.gitignore` 已忽略 `*.tgz`，但别留在仓库目录里）。

## 3. npm 发布

- [ ] npm 账号开启 2FA（授权与发布均要求）；`npm whoami` 确认已登录正确账号。
- [ ] 确认包名可用：`npm view gitrader`（返回 404 即未被占用；若被占，需改包名并同步 `README`、`bin` 说明与冒烟命令）。
- [ ] 先空跑：`npm publish -w packages/cli --access public --dry-run`
- [ ] 正式发布：`npm publish -w packages/cli --access public`（按提示输入一次性验证码）
- [ ] 核对：`npm view gitrader version dist.tarball`，页面 `https://www.npmjs.com/package/gitrader` 上许可证显示 CPAL-1.0。

## 4. 打 tag

- [ ] `git tag -a v0.1.1 -m "gitrader 0.1.1"`（想要签名 tag：`git tag -s v0.1.1 -m "gitrader 0.1.1"`，签名可选）
- [ ] `git push origin v0.1.1`

## 5. GitHub Release

- [ ] Releases → Draft a new release，选 `v0.1.1`，附上第 2 节生成的 `gitrader-0.1.1.tgz` 与校验和。
- [ ] 发布说明用下面的模板：

```markdown
## Gitrader 0.1.1

### 新增
- ……

### 修复
- ……

### 已知限制
- ……（例如：M1 默认纸面；主网真钱需自行开通并逐项授权；`bench` 仍是占位）

### 安全说明
- 默认只监听本机；令牌不写进任何配置片段；人面专属动作需要 PIN。
- 同一系统用户下的恶意代码不在保证范围，详见 `docs/security.md`。
- 发现问题请走 Security → Report a vulnerability，不要发公开 issue。

### 校验和
sha256  <填第 2 节记下的值>  gitrader-0.1.1.tgz
```

## 6. 安全披露渠道

- [ ] `SECURITY.md` 指向 GitHub 私密报告（已写，没有邮箱）；时限已写死：**首次回应 72 小时，修复窗口 90 天**——确认至少两位 owner 能做到，做不到就先改 `SECURITY.md` 再发布。
- [ ] 至少两位 owner 的 GitHub 通知邮箱能收到安全报告提醒（Settings -> Notifications）。

## 7. 发布后冒烟（干净目录，不装进仓库）

用一个空目录和独立数据目录，避免污染 `~/.gitrader`：

- [ ] `mkdir smoke && cd smoke`
- [ ] `npx gitrader@0.1.1 init --home ./gt-home`
- [ ] `npx gitrader@0.1.1 serve --offline --home ./gt-home`（另开终端；看到本地地址即成功，Ctrl+C 退出）
- [ ] `npx gitrader@0.1.1 mcp snippet claude-code --home ./gt-home`（输出应是可粘贴的 MCP 配置，不含令牌明文）
- [ ] 服务还开着时，另一终端 `npx gitrader@0.1.1 status --home ./gt-home` 能看到运行状态。

## 8. 回滚

- [ ] 有问题但已有人装：`npm deprecate gitrader@0.1.1 "原因；请升级到 x.y.z"`（只加警告，版本仍可装；这是首选）。
- [ ] 发现泄露了不该发的内容，且在发布后 **72 小时内**：`npm unpublish gitrader@0.1.1`。72 小时后、或已有其他包依赖它，就不能自助撤回，只能联系 npm 支持。撤回的版本号**不能再次使用**，修复要发新版本（如 `0.1.1`）。
- [ ] 泄露了密钥 / 令牌：先在对应平台作废，再处理包；npm 与 GitHub 上的历史内容视为已公开。
- [ ] GitHub Release 同步标注「已撤回 / 已被 x.y.z 取代」，必要时用 Security Advisory 发公告。

## 9. Release 资产

一条命令同时产出 npm 包、各平台便携包、校验清单和发布说明（仓库根执行，需要 Node >= 22.13；`.github/workflows/release.yml` 是同一件事的草稿，也可手动跑）：

- [可自动] `node scripts/release/build-release-assets.mjs`（缺省平台 `win-x64,linux-x64,darwin-arm64`，产物进 `dist-release/`；换目录用 `--out`，换平台用 `--platforms`）。
- [可自动] 离线 / 复用现成产物：`node scripts/release/build-release-assets.mjs --runtime-dir <本机 Node 目录> --skip-build`（不下载运行时、不重新构建）。只出 tgz 加 `--skip-portable`。
- [可自动] 产物清单：`gitrader-<版本>.tgz`（npm 包本体）、`gitrader-<版本>-<平台>.zip` 或 `.tar.gz`（便携包）、`SHA256SUMS`（`<sha256>  <文件名>`，按文件名排序）、`RELEASE-NOTES.md`（发布说明模板）。
- [可自动] 校验：`cd dist-release && sha256sum -c SHA256SUMS`（macOS / Linux）或 PowerShell `Get-FileHash .\<文件名> -Algorithm SHA256` 逐个比对 `SHA256SUMS`。
- [可自动] 包内容与自包含冒烟：`node scripts/verify/pack-install.mjs`（临时目录里装 tgz、跑 `--version` / `init` / `serve --offline`；要联网装依赖，约 2~3 分钟）。
- [维护者] 干净目录人工冒烟：新建空目录，`npm i -g dist-release/gitrader-<版本>.tgz`，再 `gitrader --version`、`gitrader init --no-pin`、`gitrader serve --offline`（看到本地地址即成功）。
- [维护者] 便携包只抽查一个平台：解压后双击 `start.cmd`（macOS / Linux 跑 `./start.sh`），确认终端打印出工作台地址；Windows 首次运行可能弹 SmartScreen 提示，属预期。

## 10. npm 正式发布（维护者）

- [维护者] 确认包名可用：`npm view gitrader`（返回 404 即未被占用；被占就要改包名，并同步 `README`、`bin` 说明与冒烟命令）。
- [维护者] npm 账号已登录且开启两步验证（授权与发布都要一次性验证码）：`npm whoami`。
- [维护者] 正式发布：`npm publish packages/cli --access public`；或用第 9 节打好的 tgz：`npm publish dist-release/gitrader-<版本>.tgz --access public`。
- [维护者] 发布后验证：`npx gitrader@<版本> --version`，再 `npm view gitrader version dist.tarball`，页面上许可证显示 CPAL-1.0。
- [维护者] 发出去的版本不可改：出问题走第 8 节的 `npm deprecate` / 72 小时内 `npm unpublish`，修复发新版本。
