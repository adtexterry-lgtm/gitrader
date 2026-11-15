# SPDX-License-Identifier: CPAL-1.0
# Gitrader 交付镜像（多阶段）。
#
# 结构与 QuantDinger v5.6.5 的 docker-compose*.yml / install.sh 的约定对齐（单服务 + 健康检查 +
# 具名卷 + .env 约定），内容按 Gitrader 自己的产物写：CLI 的 esbuild 单文件 bundle 自带内核与 MCP，
# 工作台与参考引擎也由同一次构建写进 packages/cli/dist/。
#
# 构建上下文是仓库根，不是 docker/：
#   docker build -f docker/Dockerfile -t gitrader:local .
#   docker compose -f docker/docker-compose.yml up -d --build
#
# 运行阶段只带：packages/cli/dist（bin.js / gitrader-mcp.js / engine-core.mjs / workbench/）+ 根 LICENSE。
# 不带源码、不带 test、不带 node_modules、不带 *_NOTICES 之外的构建输入。

# ---- 构建阶段 ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /src
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    CI=1
# npm ci 要按 package-lock.json 解析全部工作区，所以 packages/ 整棵树进镜像（源码要参与构建）。
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
# 工作台的构建脚本对 assets/brand 做 sha256 门禁（字标原件），缺了工作台构建会直接失败。
COPY assets ./assets
# packages/cli/build.mjs 会把根 LICENSE 与 NOTICE 拷进包目录，构建阶段必须先有这两个文件。
COPY LICENSE NOTICE ./
RUN npm ci
# 根 `npm run build` 只构建在 package.json 里声明了 gitrader.build 的包；CLI 自己的构建脚本
# 另外产出 dist/bin.js、dist/gitrader-mcp.js、dist/engine-core.mjs、dist/workbench/。
RUN npm run build \
 && npm run build -w gitrader

# ---- 运行阶段 ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
# GITRADER_HOME：唯一可写目录（配置、账本、密钥库、服务令牌都在这里），由具名卷挂进来。
# GITRADER_PORT：容器内监听端口，入口脚本用它给 `serve --port`。
# GITRADER_BIND：宿主机侧发布地址，compose 的 ports 用它；容器进程通过 --host 0.0.0.0 显式监听容器接口。
#   宿主侧发布仍默认回环；Host 认证白名单保持原规则，见 README「网络可达性」。
ENV NODE_ENV=production \
    GITRADER_HOME=/data \
    GITRADER_PORT=47900 \
    GITRADER_BIND=127.0.0.1 \
    GITRADER_ENGINE_CORE_BUNDLE=/app/packages/cli/dist/engine-core.mjs
RUN addgroup -S -g 10001 gitrader \
 && adduser -S -u 10001 -G gitrader -h /data -s /sbin/nologin gitrader \
 && mkdir -p /data \
 && chown -R 10001:10001 /data
COPY --from=build --chown=10001:10001 /src/packages/cli/dist ./packages/cli/dist
COPY --chown=10001:10001 LICENSE ./LICENSE
USER 10001:10001
VOLUME ["/data"]
EXPOSE 47900
# 就绪探针打 /api/ready。该路由要 Bearer 令牌（packages/kernel/src/http/server.ts），令牌在
# <GITRADER_HOME>/service.json 里，只有本进程属主可读，所以探针在同容器内取它；令牌不进命令行、
# 不进日志、不进镜像。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'const fs=require("node:fs");const home=process.env.GITRADER_HOME||"/data";let s;try{s=JSON.parse(fs.readFileSync(home+"/service.json","utf8"))}catch(e){process.exit(1)}if(!s||!s.token||!s.port)process.exit(1);fetch("http://127.0.0.1:"+s.port+"/api/ready",{headers:{authorization:"Bearer "+s.token}}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
# 入口：`exec` 让 sh 不留在进程树里；用 compose（init: true）时 PID 1 是 init 进程、node 是它的子进程，
# 收到 init 转发的 SIGTERM（serve 在 SIGTERM 时停内核）；裸 docker run 不加 --init 时 node 是 PID 1。
# 端口只从环境变量来：要换端口改 GITRADER_PORT，不要用 compose 的 command 覆盖。
# 容器首次运行时数据目录为空，先 init --no-pin 再 serve（PIN 在浏览器里设）。
ENTRYPOINT ["/bin/sh", "-c", "test -f \"${GITRADER_HOME}/service.json\" || node packages/cli/dist/bin.js init --no-pin; exec node packages/cli/dist/bin.js serve --host 0.0.0.0 --port \"${GITRADER_PORT}\""]
