# Gitrader 竖版品牌海报 · V2

`poster.png`（2048×3072）是跨机器使用的主稿，`poster-preview.png` 为 1024×1536 预览。`poster.svg` 保留原生文字与嵌入式品牌 SVG；SVG 渲染依赖 Microsoft YaHei（微软雅黑），常规与粗体分别使用本机原版字体文件。复跑脚本 `render-poster.mjs` 会在隔离字体配置下输出 PNG，并在 `MANIFEST.json` 记录尺寸、SHA-256 与渲染字体证据。

中央主视觉由内置 imagegen 按获批提示生成，保存在 `scene-v2.png` 并原样嵌入；未对该图重绘、抠图或调色。交易窗口是概念示意，不代表现有工作台实际布局，也不是实时行情。制作依据见 [施工图](BLUEPRINT.md) 与 [生成提示词](PROMPT.md)。

文案依据当前 Gitrader [项目说明](../../../README.md) 与 [安全说明](../../../docs/security.md)：海报描述可组合接入、权限控制与操作留痕，不承诺收益或策略/数据供给，不表示资金托管。
