<!-- SPDX-License-Identifier: Apache-2.0 -->
# Python GSP 参考插件

纯标准库、stdio NDJSON、Apache-2.0。这是协议参考，不含交易逻辑。
实现 `plugin.hello` / `plugin.describe` / `plugin.health` / `plugin.shutdown`
及 `tool.call` 的 `echo` 工具。stdout 只输出 JSON-RPC；错误不回显请求值。

从仓库根目录运行（已装 Node 与 Python，无下载步骤）：

```sh
node packages/protocol/examples/python-plugin/run-conformance.mjs
```

默认解释器为 `python`；若本地命令不同，用环境变量 `GSP_PYTHON` 指定已有解释器。
也可设置 `GSP_LAUNCH` 为 `{command,args,cwd,env}` 的 JSON 后运行
`npm run conformance:gsp -w packages/protocol`。令牌由套件经
`GITRADER_GSP_TOKEN` 注入，不写入清单。G01–G08 的定义见
[套件说明](../../conformance/README.md#gsp-迷你一致性套件)。

`plugin.describe` 返回完整的参考清单，按冻结的插件 schema 校验；
其中内容哈希是占位值。要安装到内核，将 `MANIFEST` 保存为同目录的
`gitrader-plugin.json`，按本机解释器调整 `x-launch.command`，再执行
`gitrader plugins pin <目录>`。开发者模式安装后需用户启用，默认权限为空。
未通过正式签名或实盘验证，不宣称具有这些能力。

hello 要求 `0.1.x`，协商为 `0.1.0`；错令牌返回 Problem 5003 后退出，
版本不兼容返回 5001。未知工具或方法为 -32601，非法参数为 -32602，
嵌套秘密字段为 5006；所有 error.data 均为 Problem。
批量请求返回数组；shutdown 应答后退出码为 0。
本例只支持 stdio，远程 wss 与 mTLS 未实测。
