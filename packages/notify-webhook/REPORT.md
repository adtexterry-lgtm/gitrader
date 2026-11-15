# 标段 B1 · notify-webhook

## 改了什么
新建 `packages/notify-webhook`：起点复制 kernel webhook.ts，对照 QD 补企业微信方言、Markdown/纯文本两形态、标题截断、retryable 判定；客户端注入 fetch/时钟/超时并指数退避。

## 跑了什么
测试 6 文件 35 例全过；tsc --noEmit 退出 0；hygiene 6 例全过（首轮因兄弟包未落 README 而红，待其落盘后复跑转绿）。

## 没做什么
未碰其它包；未 git/install/联网；QD webhook.py 无 retry（grep 空），重试集合取 signal_notifier.py:832-835；不做正文截断；B2–B4 未做。

## 需要主会话决定
1. hygiene 扫全 packages/，兄弟包未落盘时会红，收口需按完成态复跑。
2. signDingtalk 返回已 URL 编码，B4 勿重复编码。
3. send 多返回 attempts，可删。
