# SPDX-License-Identifier: CPAL-1.0
# 这个目录只放**文件形式的密钥**，供 compose 只读挂进容器：
#   gitrader-metrics-token   Prometheus 抓 /api/metrics 用的主体令牌（ops/prometheus/prometheus.yml 的 authorization.credentials_file）
#   telegram-bot-token       Alertmanager 的 bot_token_file
#   alertmanager-webhook     Alertmanager 的 credentials_file
#   smtp-password            Alertmanager 的 auth_password_file
#   grafana-admin            Grafana 管理员密码（compose 的 GF_SECURITY_ADMIN_PASSWORD__FILE）
#
# 怎么写：
#   printf '%s\n' '<值>' > docker/secrets/gitrader-metrics-token
#   chmod 600 docker/secrets/gitrader-metrics-token
#
# 这个目录里的真实文件已被同目录的 .gitignore 排除（只放行本 README 与 .gitignore 自身）。
# 不需要观测栈时，整目录留空即可——gitrader 主服务不用它。
