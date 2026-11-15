# 安全政策 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 issue、讨论区或社交媒体上披露可利用的细节。
Please do **not** disclose exploitable details in public issues, discussions or social media.

唯一的披露渠道是 GitHub 私密漏洞报告：仓库页面 **Security → Report a vulnerability**（GitHub Security Advisories）。
The only disclosure channel is GitHub private vulnerability reporting: **Security → Report a vulnerability** on the repository page.

**渠道占位（首发前替换）**：`https://github.com/<org>/<repo>/security/advisories/new`。`<org>/<repo>` 在仓库建好后替换成真实名字（`docs/release-checklist.md` 第 1 步）；同时要在仓库设置里打开 Private vulnerability reporting，否则这个入口不存在。我们没有公开的安全邮箱，也不接受私信或社交媒体上报——这两个渠道没有人值守，而且容易漏。
Channel placeholder: the URL above, with `<org>/<repo>` replaced once the repository exists, and Private vulnerability reporting enabled in the repository settings. There is no public security e-mail address; reports sent by direct message or social media are not monitored.

报告里请写清：影响了什么、怎么复现（优先用纸面账户或 `serve --offline`）、你测试的版本与系统。**不要**附带私钥、API 钱包密钥、令牌或 PIN。
Include what is affected, how to reproduce (prefer a paper account or `serve --offline`), and the version and OS you tested. **Never** attach private keys, API wallet keys, tokens or PINs.

## 响应时限 / What to expect

- **首次回应 / First response: 72 小时内 / within 72 hours**（确认收到，指定一位跟进人）。
- **修复窗口 / Fix window: 90 天 / 90 days**，从首次回应起算：我们在此期间修复并发布，或与你商定延期。严重度高的问题会更快。
- 修复发布后，我们发布安全公告（GitHub Security Advisory，必要时申请 CVE），经你同意在公告里致谢。
- 90 天到期仍未修复且未商定延期时，你可以公开披露；我们希望你先通知我们。
- 在窗口内请不要公开细节，也请不要对他人的资金、账户或服务做测试。善意、在本机自己的环境里进行的研究，我们不会追究。

We publish a security advisory after the fix ships and credit you with your consent. If 90 days pass without a fix or an agreed extension, you may disclose publicly; we ask that you tell us first. Please test only against your own local setup, never other people's funds, accounts or services; good-faith research on your own machine will not be pursued.

## 范围 / Scope

- 在范围内 / In scope: `gitrader` npm 包（命令行、本地内核、工作台、MCP 服务器）、签名与账本、鉴权与钥匙、风控与人面专属动作。
- 不在范围内 / Out of scope: 同一系统用户下的恶意代码（本机同权限进程，见 `docs/security.md`）、第三方场所或依赖自身的漏洞（请报给上游）。

威胁模型与边界见 `docs/security.md`。
Threat model and boundaries: `docs/security.md`.

## 支持的版本 / Supported versions

| 版本 | 状态 |
|---|---|
| 0.1.x | 接收安全修复 / receives security fixes |
