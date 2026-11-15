<!-- SPDX-License-Identifier: CPAL-1.0 -->
# 可观测性（Prometheus / Alertmanager / Grafana）

内核已经通过 `GET /api/metrics` 暴露 Prometheus 文本格式指标（`packages/kernel/src/metrics.ts`），
由 `Authorization: Bearer <主体令牌>` 鉴权（`packages/kernel/src/http/server.ts`）。
本目录只放**采集与展示侧**的配置：不启动任何服务，不含任何密钥，也不改内核代码。

结构抄自 QuantDinger v5.6.5（Apache-2.0）的 `ops/`、`docs/deployment/OBSERVABILITY_CN.md`；文件头逐条注明来源。

## 文件

| 文件 | 用途 |
| --- | --- |
| `prometheus/prometheus.yml` | 抓取 `/api/metrics`（Bearer 从文件读）、加载 `alerts.yml`、指向 Alertmanager |
| `prometheus/alerts.yml` | 已有的 7 条规则，**本批次未改动**，只被引用 |
| `alertmanager/alertmanager.yml` | 按 `severity` 分流；telegram / webhook / email 三个占位接收器 |
| `grafana/dashboards/gitrader-overview.json` | 运行状态、事件速率、账本增长、交易状态、内存 |
| `grafana/provisioning/datasources/prometheus.yml` | 数据源（uid `prometheus`） |
| `grafana/provisioning/dashboards/dashboards.yml` | 仪表盘自动装载 |
| `verify-ops.mjs` | 离线自检（指标名 / 标签 / YAML 结构 / 密钥），退出码 0 或 1 |

## 指标

| 指标 | 类型 | 标签 |
| --- | --- | --- |
| `gitrader_up` | gauge | — |
| `gitrader_uptime_seconds` | gauge | — |
| `gitrader_ledger_entries` | gauge | — |
| `gitrader_trading_state` | gauge（当前状态为 1） | `state` ∈ ACTIVE / REDUCING / HALTED |
| `gitrader_events_total` | counter | `topic` ∈ `EVENT_TOPICS`（24 个，见 `packages/kernel/src/events.ts`） |
| `gitrader_op_rate_limited_total` | counter | `principal`（哪个身份被限流） |
| `gitrader_process_rss_bytes` | gauge | — |
| `gitrader_process_heap_used_bytes` | gauge | — |

仪表盘与告警规则只允许出现上表里的名字和标签；`node ops/verify-ops.mjs` 会拿
`metrics.ts` / `events.ts` / `packages/protocol/src/model/risk.ts` 对账。

## 起监控栈（示例，不随产品发布）

下面的 compose 片段是**示例**：不放进仓库根，用的时候单独存成文件再 `docker compose -f ... up -d`。
镜像版本照 QuantDinger v5.6.5 的 `docker-compose.observability.yml` 取；端口只绑 `127.0.0.1`。

```yaml
services:
  prometheus:
    image: prom/prometheus:v3.12.0-distroless
    restart: unless-stopped
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.path=/prometheus
      - --web.enable-lifecycle
    volumes:
      - ./ops/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./ops/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro
      - ./ops/secrets/gitrader-metrics-token:/etc/prometheus/secrets/gitrader-metrics-token:ro
      - prometheus_data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"
    extra_hosts:
      - "host.docker.internal:host-gateway"

  alertmanager:
    image: prom/alertmanager:v0.32.1
    restart: unless-stopped
    command:
      - --config.file=/etc/alertmanager/alertmanager.yml
      - --storage.path=/alertmanager
    volumes:
      - ./ops/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - ./ops/secrets:/etc/alertmanager/secrets:ro
      - alertmanager_data:/alertmanager
    ports:
      - "127.0.0.1:9093:9093"

  grafana:
    image: grafana/grafana:13.0.2
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:?先设置再启动}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_AUTH_ANONYMOUS_ENABLED: "false"
    volumes:
      - grafana_data:/var/lib/grafana
      - ./ops/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./ops/grafana/dashboards:/var/lib/grafana/dashboards:ro
    ports:
      - "127.0.0.1:3000:3000"

volumes:
  prometheus_data:
  alertmanager_data:
  grafana_data:
```

容器里的 Prometheus 抓不到宿主机 `127.0.0.1`，把 `prometheus.yml` 里 `targets` 改成
`host.docker.internal:47900`（`47900` 是 `packages/kernel/src/config.ts` 的 `DEFAULT_PORT_START`，
被占用时内核会顺延到后续端口，用 `gitrader status` 看实际端口）。

不用容器也可以直接用二进制：`prometheus --config.file=ops/prometheus/prometheus.yml`、
`alertmanager --config.file=ops/alertmanager/alertmanager.yml`，
Grafana 起好后把 `ops/grafana/provisioning` 挂到它的 `provisioning` 目录。

## 令牌与密钥

- `/api/metrics` 要的是内核的主体令牌，写进一个 0600 的文件，用 `authorization.credentials_file` 引用；
  日志、compose、本目录的任何文件都不写令牌值。
- Alertmanager 的 Telegram 机器人令牌、SMTP 密码、webhook Bearer 令牌同样只走 `*_file` 文件引用。
- **Alertmanager 不会展开 `${ENV}`**：如果更想用环境变量，必须在启动前把 `alertmanager.yml` 当模板
  用 `envsubst` 渲染成临时文件再挂进去（渲染产物不要提交）。本目录的默认写法是文件引用，开箱可用。
- Grafana 管理员密码从 `GRAFANA_ADMIN_PASSWORD` 进容器；仓库里没有默认密码。

## 告警路由

- `critical` → Telegram，并且 `continue: true` 继续发给 webhook；`critical` 抑制同名 `warning`。
- `warning` → webhook（值班网关）。
- `info` → 邮件摘要（最长的 `repeat_interval`）。
- 规则本身在 `prometheus/alerts.yml`（7 条，未改动），阈值是初始取值，按自己的部署调。

## 自检

```
node ops/verify-ops.mjs
```

做四件事，任何一条失败退出码 1 并列出失败项：

1. 仪表盘所有 `expr` 里的 `gitrader_*` 与 `metrics.ts` 双向比对（引用了不存在的指标 / 指标没上盘）。
2. `expr` 里的标签名与 `topic` / `state` 取值对照 `events.ts`、`risk.ts`。
3. 用内置的最小 YAML 子集解析器读 `prometheus.yml`、`alertmanager.yml` 与两个 provisioning 文件，
   断言抓取路径、Bearer 文件引用、severity 路由完整性、接收器名闭合、数据源 uid 一致。
   （没有引入第三方 YAML 库；解析器只覆盖字符串键值、块序列、行内 `[a, b]` / `{a: b}`，
   不支持锚点 / 多文档 / 多行标量——所以配置文件里也没用这些写法。）
4. 扫本目录所有文本文件，拦疑似真实令牌与明文密码。

## 注意

- 内核只绑 `127.0.0.1`；Prometheus / Alertmanager / Grafana 也不要暴露到公网，默认保持 loopback 绑定。
- 本目录不含对未来的推断数字，指标与告警只陈述事实。
