# REPORT · plugin-notify-email

## 改了什么
新建 17 文件：清单、gsp.mjs、index.mjs、smtp/mime/render/secret.mjs（库的 JS 副本，头注来源）、fake-smtp.mjs、工程 5 件、测试 4 个。

## 跑了什么
vitest 4 文件 31 例全过；conformance G01–G08 共 8 例全过；tsc exit 0；hygiene 6 例全过。

## 没做什么
未联网验真实 SMTP；无 DKIM、附件、队列重试、正文分块。

## 需要主会话决定
① 工具名不许点号：清单写 `notify_send`，GSP 兼容 `notify.send` 别名；B2/B4 仍写 `notify.send`。
② net.hosts 无「任意主机」写法，主机来自配置，静态写 localhost。
③ `privacy.sends` 无「通知文本」枚举，声明 `[]`。
④ `net.fetch` 仅四个 kind 可申请，故 kind=connector、package=block。
