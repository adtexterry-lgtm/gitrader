> 许可证：CPAL-1.0。

# 便携包构建（`tools/portable/`）

把 `npm run build -w gitrader` 的产物（都在 `packages/cli/dist/` 里：`bin.js`、`engine-core.mjs`、`workbench/`）
和官方 Node 运行时拼成一个目录，压成一个压缩包：解开、双击 `start.cmd`（或在终端跑 `./start.sh`），本机内核 + 工作台就起来了，
**不需要用户先装 Node**。

生成的包长这样（`gitrader-<版本>-<平台>/`）：

```
gitrader-<版本>-<平台>/
  runtime/node(.exe)          官方 Node 运行时（解压出来的可执行文件；有 LICENSE 就一并带上）
  app/cli/                    packages/cli/dist/*（bin.js、gitrader-mcp.js、engine-core.mjs、workbench/）
  bin/gitrader.cmd            Windows 启动器：runtime\node.exe app\cli\bin.js %*
  bin/gitrader                macOS / Linux 启动器：exec runtime/node app/cli/bin.js "$@"
  start.cmd / start.sh        首次运行 init --no-pin，然后 serve 并自动开浏览器（start.cmd 用 PowerShell 管道抓链接）
  README.txt                  中英双语：解压 / 启动 / 打开地址三步 + 其它命令 / 改端口与数据目录两步，另有升级与卸载说明
  VERSION                     版本号 + 运行时版本 + 平台
  LICENSE                     CPAL-1.0（从根 LICENSE 复制）
  THIRD_PARTY_NOTICES.md      从根复制
  manifest.json               文件清单 + 每个文件的 sha256 + 文件数 / 字节数 + Node 版本 + 构建时间
```

`app/cli/` 里自带工作台与引擎：CLI 找静态目录的顺序里包含 `<bin.js 所在目录>/workbench`（`packages/cli/src/index.ts` 的 `defaultStaticDir`），
找引擎的顺序里包含 `<bin.js 所在目录>/engine-core.mjs`（`packages/kernel/src/engines.ts:318`），
所以 `app/cli/bin.js` 配 `app/cli/workbench/index.html`、`app/cli/engine-core.mjs` 正好命中，不需要额外传 `--static` 或单独拷目录。

## 构建

在仓库根执行（`npm run build -w gitrader` 由脚本自己调，不用先手动构建）。根 `package.json` 里有同义快捷方式：`npm run pack:portable -- --platform win-x64 [--runtime-dir <本机 Node 目录>]`，等于下面第一条命令。`packages/*/dist` 是本地构建产物，可能落后于源码；验收一律以新打的包为准（别加 `--skip-build` 复用旧 `dist/`）。

```sh
node tools/portable/build-portable.mjs                                  # 本机平台，下载 Node 22.23.2，构建 + 打包
node tools/portable/build-portable.mjs --platform linux-x64             # 交叉装配 Linux 包
node tools/portable/build-portable.mjs --platform darwin-arm64 --node 22.13.1
node tools/portable/build-portable.mjs --out dist-portable              # 产物目录（缺省就是 dist-portable）
```

参数：

| 参数 | 作用 |
|---|---|
| `--platform win-x64\|linux-x64\|darwin-arm64\|darwin-x64` | 目标平台，缺省按当前机推断（认不出就报错，不瞎猜） |
| `--node <x.y.z>` | 运行时版本，缺省 `22.23.2`；低于 22.13（`packages/cli/package.json` 的 `engines.node`）直接拒 |
| `--runtime-dir <目录>` | 用本机已有的 Node 目录（含 `node` 或 `node.exe`，或 `bin/node`），**给了就不联网** |
| `--out <目录>` | 产物目录，缺省 `dist-portable` |
| `--repo-root <目录>` | 仓库根，缺省按脚本位置推导（测试用假仓库时给定） |
| `--skip-build` | 跳过 `npm run build -w gitrader`，直接用现有 `dist/` |
| `--no-pack` | 只装配目录，不打包 |

产物：

- `dist-portable/gitrader-<版本>-<平台>/`（目录，可直接拷走）
- `dist-portable/gitrader-<版本>-<平台>.zip`（Windows 目标）/ `.tar.gz`（unix 目标）
- `dist-portable/.runtime-cache/node-v<版本>-<平台>/`（下载过一次就复用，不再重复下载）

三个平台的包不能用同一个系统跑同一遍就出齐：**Windows 目标包要在 Windows 上打（zip 用 PowerShell）**，
unix 目标包要在 unix 上打（tar 保留可执行位），或者交叉装配后用对应平台的工具自己压。

## 校验和 / 下载

不给 `--runtime-dir` 时，脚本从 `https://nodejs.org/dist/v<版本>/` 取 `SHASUMS256.txt` 和对应平台的归档，
**先算 sha256 并与清单比对，通过才解压**；不一致就删掉下载的文件并报 `CHECKSUM_MISMATCH`，缓存里不留坏包。
下载只在这条路径上发生，测试与日常开发不联网。

## 验证

单元测试（全离线：假运行时目录 + `--skip-build` + 假 `SHASUMS256.txt`，不下载、不构建）：

```sh
node --test tools/portable/test         # 目录写法（经 test/package.json 的 main 汇总五个文件）
node --test "tools/portable/test/*.test.mjs"   # 等价：逐个文件跑
```

测试覆盖：目录结构与必须文件、启动脚本内容（`runtime/node` 调用、`init --no-pin` 只在缺配置时跑）、
README 的五行步骤、便携包的 bin/ 启动器与 --port / GITRADER_HOME 两条、零承诺语言、`manifest.json` 里每个文件的 sha256 与磁盘字节一致、包里没有构建机绝对路径、
Windows / Linux / macOS 三种运行时落位（`node.exe` vs `bin/node`）、版本号取自根 `package.json`、
运行时 Node 版本探测（问运行时本身 / 认 node-v<版本>-<平台> 目录名 / 低于 22.13 拒绝）、缺运行时 / 缺 dist / 参数错误的退出码，以及 sha256 校验的通过与不通过两条路径（坏包必须删掉且不解压）。
打包测试在本机平台真打一次包，再解压回来比对文件清单。

用真机检查一个做完的包（`<平台>` 换成实际值）：

```sh
# 1) 解压后是否只有一个顶层目录
tar -tf dist-portable/gitrader-<版本>-win-x64.zip | head        # zip 也可用 PowerShell：
# powershell -NoProfile -Command "Get-ChildItem -Recurse dist-portable\...zip"  # 或用 7-Zip 看条目
# 2) manifest 里的哈希是否与文件一致（任何机器都能算）
cd dist-portable/gitrader-<版本>-<平台> && sha256sum app/cli/bin.js   # 与 manifest.json 里同一路径对比
# 3) 起得来
start.cmd            # Windows：双击或 cmd 里执行
./start.sh           # macOS / Linux
```

手工跑一次真实骨架（不联网、不碰你日常的 `~/.gitrader`）：

```sh
GITRADER_HOME=$(mktemp -d) ./runtime/node app/cli/bin.js init --no-pin
GITRADER_HOME=<同一个目录> ./runtime/node app/cli/bin.js serve --offline --port 7391
# 浏览器打开终端打印的那行地址；Ctrl+C 停止
```

## 已知限制（如实）

- **没有代码签名**。Windows 首次运行 `start.cmd` 会弹 SmartScreen「已保护你的电脑」，需要「更多信息 → 仍要运行」。
  macOS 上 `./start.sh` 可能被 Gatekeeper 拦（`xattr -d com.apple.quarantine` 才放行）。发行方身份与文件哈希见 `manifest.json`。
- **Node 运行时只按 `SHASUMS256.txt` 校验 sha256**，没有验 GPG 签名；清单与归档都来自同一个 TLS 连接（nodejs.org），
  因此信任链止于 TLS。要更严的话，自己下 Node 官方归档、核对签名后传 `--runtime-dir`。
- **压缩包不可复现**：`manifest.json` 里带构建时间，zip 里带文件修改时间，两次构建的字节不会相同（内容一致，哈希不同）。
- **Windows zip 的条目名用反斜杠**（PowerShell 5.1 `Compress-Archive` 的老毛病）。资源管理器、7-Zip、`Expand-Archive`、
  以及读中央目录的解压器都正常；只用本地头的老工具可能解出奇怪文件名。unix 目标走 `tar.gz`，不受影响且保留可执行位。
- **macOS / Linux 的包没有在对应真机上构建或跑过**（构建机只有 Windows）；`tar` 打包与 `chmod +x` 的路径是照文档写的，
  本地只在 Windows 上做了交叉装配（`--platform linux-x64|darwin-arm64` 的目录布局与启动脚本由测试覆盖）。
- 包只监听 `127.0.0.1`；首次运行不做 PIN 交互（`init --no-pin`），因此 `grant` / `bind` 这类要 PIN 的操作
  需要在终端里再跑一次 `gitrader init` 设 PIN。便携包不改变这条产品约束。
- 工作台地址是一次性、两分钟有效的引导链接；`start.cmd` 不自动开浏览器，地址由 `serve` 打印。
- 默认 Node 版本 `22.23.2` 只是「≥ 22.13 的最低可用版本」；想换版本用 `--node`（同时会下载对应平台归档）。
- 版本号取自仓库根 `package.json`（当前 `0.1.1`）；`packages/cli/package.json` 里写的是 `0.1.0`、CLI 自己打印的
  `KERNEL_VERSION` 也是 `0.1.0`，两者尚未统一，便携包目录名以根 `package.json` 为准。
