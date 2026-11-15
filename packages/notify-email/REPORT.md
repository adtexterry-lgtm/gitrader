# REPORT · notify-email

## 改了什么
新建 13 文件：src 5、test 3 组 24 例、配置 4。仅 node:net/tls/crypto。

## 跑了什么
vitest exit 0，3/24 passed；tsc exit 0；hygiene 1/6 passed。全离线，假连接按预设应答。

## 没做什么
465 隐式 TLS、587 STARTTLS 升级重 EHLO；AUTH PLAIN→LOGIN；多行应答拼接；超时 15s；密码只从构造参数进、错误过 redactSecret、认证命令不回显。

## 需要主会话决定
①真实 nodeConnector 只有类型检查未联网实测 ②AUTH LOGIN 无独立用例 ③重试/附件/DKIM 未做。
