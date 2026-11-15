# Gitrader 的 Docker 交付

[English](README.md)

一个容器跑 `gitrader serve`：内核 + 工作台 + 参考引擎，数据放具名卷。观测栈（Prometheus /
Alertmanager / Grafana）是**可选的第二个 profile**，默认不启动。

这份交付是容器化的**运行形态**，不改变 Gitrader 的安全模型：内核仍是本机服务，所有 `/api`
请求要 Bearer 令牌（`/api/health` 除外），密钥只在 `<GITRADER_HOME>` 里、由属主 10001 读写。

## 前提

- Docker 24+，Docker Compose v2（`docker compose version`）。
- 构建上下文是**仓库根**（不是本目录）：镜像要 `npm ci` 全工作区再 `npm run build`。
- 首次构建需要联网拉基础镜像与 npm 依赖；运行时不需要网络也能起（行情连接失败只影响行情）。

## 起

### 首次运行：自动初始化或手动设 PIN

首次启动时，如果数据目录未初始化，容器会在启动 `serve` 之前自动运行 `init --no-pin`。因此可以直接这样启动：

```sh
cd docker
cp .env.example .env          # 只有端口 / 时区 / 日志级别
docker compose build
docker compose up -d --build
```

工作台会在日志里打印一条一次性链接（两分钟有效、只能用一次）。用下面的命令取出：

```sh
docker compose logs gitrader
```

在浏览器里打开那个链接，在工作台界面里设置 PIN。

**可选：启动服务前先在终端交互设 PIN**（可选，原来的做法照样可用）

如果你更喜欢在启动服务之前先在终端里交互设置 PIN：

```sh
docker compose run --rm --entrypoint node gitrader packages/cli/dist/bin.js init
```

终端里按提示输入两次 PIN。`init` 是幂等的：如果实例已经初始化，它只打印提示，不会覆盖。

实例初始化并设好 PIN 后，`open --print` 可以用该 PIN 取回工作台链接：

```sh
docker compose exec gitrader node packages/cli/dist/bin.js open --print
```

只想看状态 / 账本，不必开工作台：

```sh
docker compose exec gitrader node packages/cli/dist/bin.js status
docker compose exec gitrader node packages/cli/dist/bin.js ledger
```

### 宿主端口必须等于 GITRADER_PORT

服务对 `Host` 头做防 DNS 重绑定校验，只认回环地址加上服务自己的端口：`127.0.0.1:<端口>`、`localhost:<端口>` 或 `[::1]:<端口>`。

`docker-compose.yml` 已经让两边用同一个端口。如果要换端口，改 `.env` 里的 `GITRADER_PORT`（容器监听端口与宿主发布端口一起变）。

**错误写法**：`docker run -p 127.0.0.1:48000:47900 ...` → 浏览器发 `Host: 127.0.0.1:48000`，但服务期望 `Host: 127.0.0.1:47900` → `403 Host not allowed`。

**正确写法**：`docker run -e GITRADER_PORT=48000 -p 127.0.0.1:48000:48000 ...`

## 停

```sh
docker compose down          # 停容器，保留 gitrader-data 卷（账本、配置、密钥库都在里面）
docker compose down -v       # 连卷一起删：等于清空这个实例，密钥库也一起没了，删前先备份
```

## 升级

```sh
cd docker
git -C .. pull --ff-only                # 或换一套源码
docker compose build --pull gitrader    # 重新 npm ci + npm run build，产物换新
docker compose up -d gitrader
```

数据在具名卷里，升级不动它。版本回退就是把源码切回旧 tag 再 `build` + `up -d`；卷格式若有迁移，
会在 `docker compose logs gitrader` 里报错，不会静默改数据。

## 备份与恢复卷

卷名是 `gitrader_gitrader-data`（compose 项目名 + 卷名）：

```sh
# 备份（先停服务，保证账本没有半写状态）
docker compose stop gitrader
docker run --rm -v gitrader_gitrader-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/gitrader-data-$(date +%Y%m%d).tgz -C /data .
docker compose start gitrader

# 恢复（先清空卷，再解回来）
docker compose stop gitrader
docker run --rm -v gitrader_gitrader-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/gitrader-data-YYYYMMDD.tgz -C /data'
docker compose start gitrader
```

备份包含 `service.json`（服务令牌）、`keys/`（PIN 与设备密钥）、账本与实验产物。**按密钥对待**：
不要进聊天软件、不要进仓库、不要放到共享盘；它和 PIN 一起泄露等于把实例交出去。

## 密钥怎么传

镜像与 compose 里**没有任何密钥值**，三种入口：

1. **运行期环境变量**（内核自己读）：`gitrader.json` 里的秘密字段可以写句柄 `env:变量名`，
   `serve` 启动时从自己的环境解析。在 compose 里用 `environment:` 或 `env_file:` 给，
   值由你放在宿主机的文件里，不要写进 `.env.example` 或仓库。
2. **文件引用（`*_file`）**（观测栈用）：Prometheus 的 `authorization.credentials_file`、
   Alertmanager 的 `bot_token_file` / `credentials_file` / `auth_password_file`、
   Grafana 的 `GF_SECURITY_ADMIN_PASSWORD__FILE`。它们都指向 `docker/secrets/` 下的文件，
   compose 把该目录只读挂进容器：

   ```sh
   mkdir -p docker/secrets
   printf '%s\n' '<令牌>' > docker/secrets/gitrader-metrics-token
   chmod 600 docker/secrets/gitrader-metrics-token
   ```

   这个目录只有 `README.md` 与 `.gitignore` 会进仓库，真实文件被 `docker/secrets/.gitignore` 排除。
3. **容器内 CLI**：`docker compose exec gitrader node packages/cli/dist/bin.js keys import <名字>`
   ——私钥从终端读，不进 argv、不进日志、不进镜像层。

## 健康检查

镜像自带 `HEALTHCHECK`：每 30 秒 `GET /api/ready`，容器内**用 `/data/service.json` 里的服务令牌**
带 `Authorization: Bearer`（这个路由要鉴权；`/api/health` 是唯一免令牌的数据接口）。令牌不出现在
命令行、镜像层与 `docker inspect` 的输出里——探针只读文件。

`/api/ready` 在「内核起来 + 账本可读」时返回 200，否则 503。`HALTED` 交易状态**不算**不就绪
（它与就绪是两件事）。要看细节：

```sh
docker inspect --format '{{json .State.Health}}' gitrader | head -c 400
```

## 观测（可选 profile）

```sh
# 先写管理员密码文件，否则 Grafana 起不来
printf '%s\n' '<强密码>' > docker/secrets/grafana-admin
docker compose --profile observability up -d
```

- Prometheus `127.0.0.1:9090`，配置与规则直接挂 `../ops/prometheus/{prometheus.yml,alerts.yml}`（不改仓库里的文件）。
- Alertmanager `127.0.0.1:9093`，配置挂 `../ops/alertmanager/alertmanager.yml`（接收器都是占位模板）。
- Grafana `127.0.0.1:3000`，预置数据源与 `gitrader-overview` 仪表盘（`../ops/grafana/**`）。
- 抓取地址写在 `ops/prometheus/prometheus.yml` 里（`127.0.0.1:47900`）。**容器里的 Prometheus 抓不到
  另一容器回环上的内核**——见下节；要用就得把 targets 改成 `host.docker.internal:47900` 并让内核
  接受这个 Host（同样受下节限制）。

## 网络可达性（必读，如实）

容器入口显式以 `serve --host` 绑定容器接口，compose 的 `ports:` 可转发到该监听端口。`GITRADER_BIND`
仍只控制**宿主侧**发布地址，默认仅发布到回环。内核的 Host 认证白名单保持原规则，只接受
`127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>` 三种 Host（防 DNS 重绑定）；容器监听或宿主发布地址
都不会放宽此白名单，不能据此声称任意远程 Host 可访问。

日志格式由 `GITRADER_LOG_FORMAT` 选择，默认 `text`，也可选 `json`；`GITRADER_LOG_LEVEL` 仍不是有效的级别开关。

## 已知限制

- **验证范围**：0.1.0 发布前在真实 Docker 主机上构建并按上面的端口口径起过容器，`/api/health` 返回 200；`node docker/verify-docker.mjs` 另做离线结构校验
  （COPY 路径存在、compose 引用的文件存在、`.env.example` 无密钥形状、本文件无禁词与本机路径）。
- 构建上下文用 `docker/Dockerfile.dockerignore`（BuildKit 的「与 Dockerfile 同名」忽略文件，Docker 23+ 默认开启）
  排除 `.git`、`node_modules`、各包 `dist`、`reports`、备份 tgz、`.env` 与 `docker/secrets`。老版本 Docker 或关掉
  BuildKit 时它不生效，上下文会带上这些目录（能构建，只是发送更慢）。
- 日志没有级别开关，`GITRADER_LOG_LEVEL` 现在只被透传（`.env.example` 里已注明）。
- 基础镜像用 `node:22-alpine`（跟随 22.x 最新补丁）；要可复现的构建就自己按 digest 钉住。
- 镜像里没有 `git`、`curl`、shell 工具链，只有 node 与 `packages/cli/dist`（bin.js / gitrader-mcp.js /
  engine-core.mjs / workbench/）；要调库用 `docker compose exec` + node。
