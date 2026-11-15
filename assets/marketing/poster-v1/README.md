# Gitrader 竖版品牌海报 · V1

`poster.png`（2048×3072）是跨机器查看与使用的主稿；`poster-preview.png` 是等比缩小预览。`poster.svg` 保留原生文字和嵌入的品牌 SVG，便于继续编辑；打开或渲染 SVG 需要安装 Microsoft YaHei（微软雅黑），常规字重使用原版 `msyh.ttc`，粗体使用原版 `msyhbd.ttc`。海报 PNG 在隔离字体配置下渲染。

主视觉以已生成的 `hero-v1.png` 为输入，由内置 imagegen 按获批透明背景编辑提示生成 `hero-v2-alpha.png`；成稿仅嵌入该原始 RGBA 文件，不手工抠图、调色、裁切、遮罩或重绘。制作依据与提示词见 [BLUEPRINT](BLUEPRINT.md)、[原始生成提示词](PROMPT.md) 和 [透明背景编辑提示词](PROMPT-alpha.md)。可复跑流程见 `render-poster.mjs`，源文件与输出的 SHA-256、尺寸和字体匹配证据记录在 `MANIFEST.json`。

产品事实依据：仓库 [README](../../../README.md) 当前说明 Gitrader 是 Agent Trading 开源底座、M1 施工中，并明确不提供策略/数据/因子及不托管资金；知识库《产品定义-2026-10-10》“一、产品定义”及“二、开源策略”用于对照，海报仅采用与当前仓库一致的表述，不作发布或收益承诺。
