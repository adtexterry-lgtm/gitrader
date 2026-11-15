<!-- SPDX-License-Identifier: CPAL-1.0 -->
# Prometheus 告警规则（Gitrader 内核）

`alerts.yml` 改编自 QuantDinger v5.6.5 `ops/prometheus/alerts.yml`（Apache-2.0），只引用内核
`/api/metrics` 真实暴露的指标与标签；规则与指标名的一致性由 `packages/kernel/test/alerts-config.test.ts` 守护。

## 挂进 Prometheus

1. 把 `alerts.yml` 放到 Prometheus 能读到的位置，或直接指向仓库里的这个文件。
2. 在 `prometheus.yml` 里加 `rule_files: ["/etc/prometheus/alerts.yml"]`。
3. 让抓取作业指向内核 `/api/metrics`；内核默认端口 47900（`packages/kernel/src/config.ts` 的 `DEFAULT_PORT_START`，被占用时会顺延，用 `gitrader status` 看实际端口），且要求 Bearer 鉴权，令牌用 `authorization.credentials_file` 从文件读：

   ```yaml
   scrape_configs:
     - job_name: gitrader-kernel
       metrics_path: /api/metrics
       authorization:
         type: Bearer
         credentials_file: /etc/prometheus/secrets/gitrader-metrics-token
       static_configs:
         - targets: ["127.0.0.1:47900"]
   ```

   容器里的 Prometheus 抓宿主机上的内核时，把地址换成 `host.docker.internal:47900`。这份写法与 `prometheus.yml` 里的 `gitrader-kernel` 作业一致。

4. 重载配置（`SIGHUP` 或 `/-/reload`），在 Prometheus 的 `/alerts` 页确认规则已加载。

## 鉴权

`/api/metrics` 要求主体鉴权头（Bearer），抓取配置里要带上；`authorization.credentials_file` 只写**文件路径**，令牌值不进任何进了版本库的文件（权限 0600）。令牌的来源与轮换见内核 README 的主体鉴权说明，本文件不写任何令牌。

## 关于阈值

每条规则的阈值只在注释里写初始取值与出处，不代表这些数值在任意部署下合适，按自己的环境调整。
