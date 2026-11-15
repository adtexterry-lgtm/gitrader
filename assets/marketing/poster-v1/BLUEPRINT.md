# GT-POSTER-01 · 竖版品牌海报施工图

## 目标与设计契约

2048×3072 静态海报。受众为开发者与交易工具构建者；logo 是读序前置品牌锚点，主要内容读序统一为：标题 → 模块 → 价值，即理解可组合底座 → 看懂组件接入隐喻 → 记住三项价值。成功标准是缩小后仍清楚读到定位，不被误认成收益宣传、交易所或硬件广告。

视觉句：**在大面积近黑留白中，以暖白粗标题和一组精密石墨插件底座，表达可组合、受控、可追溯的 Agent Trading 基础设施。**

沿用已批准品牌，不搜字体或趋势；字体、色彩锁定，构图为本次施工定案。三个识别点：原版 G/i 橙点字标、克制橙色导光插槽、三枚同系统可插接组件。依据为 维护者 品牌要求及主代理已核验的当前 README；不沿用历史收费/上线口径。取舍：不放 UI 截图、功能清单、CTA 或装饰图标，以定位辨识优先；模块是软件组合的视觉隐喻，不是实物产品。

## 画布与排版

SVG viewBox `0 0 2048 3072`，最终 PNG 同尺寸；sRGB、不透明。原点左上，以下文字 y 均为 alphabetic baseline，x 为左端（另注除外）。正文必须为原生 SVG text，不栅格化、不生成、不拉伸；字号不允许自动适配。

SVG 保留原生 text 供编辑，本机微软雅黑是明确的渲染依赖；PNG 是跨机发布主稿。README 必须说明打开/渲染 SVG 需安装微软雅黑，不得宣称无字体依赖；验收须确认 PNG 实际使用指定 TTC 渲染，而非字体回退。

字体证据补充：允许 renderer 建立本机临时字体目录，仅放原版 `msyh.ttc` 与 `msyhbd.ttc`，以独立 fontconfig 配置和缓存隔离系统/用户字体目录；配置须在启动渲染进程及加载 Sharp/librsvg 前生效，不改变全局系统配置。保留两源 TTC 的哈希、隔离字体清单以及本次渲染进程的匹配/加载证据，确认400与700来源；仅证明文件已安装或仅声明 font-family 不足。不得打包、分发或嵌入字体文件；SVG 的安装字体依赖不变，PNG 为跨机主稿。

| 层 | 坐标/尺寸 | 内容与样式 |
|---|---|---|
| 背景 | x0 y0 w2048 h3072 | `#0A0A0B`，纯色 |
| 原标志 | x147.2 y147.2 w670.045676654 h153.6 | 原 viewBox `0 0 1046.946369771124 240`，等比0.64；可见左/上边约160 |
| Eyebrow | x160 y444 | `AGENT TRADING INFRASTRUCTURE`；28px/400，字距3px，次级灰 |
| 主标题1 | x160 y688 | `AI 交易的`；208px/700，字距0，暖白 |
| 主标题2 | x160 y916 | `可组合底座`；208px/700，字距0，暖白；基线间距228 |
| 副标题 | x164 y1050 | `连接智能体、策略引擎与交易场所。`；44px/400，字距0，次级灰 |
| 主视觉 | x0 y1192 w2048 h1365.333333 | 3:2 无字 RGBA `hero-v2-alpha.png`，等比显示；详见下节 |
| 三项价值 | x160 / 744 / 1328，y2776 | 分别 `自由组合` / `权限可控` / `操作留痕`；48px/700，暖白；不画斜杠、边框或图标 |
| 页脚左 | x160 y2912 | `开源底座 · M1 开发中`；30px/400，次级灰 |
| 页脚右 | x1888 y2912，右对齐 | `不托管资金`；30px/400，次级灰 |

字体统一 `Microsoft YaHei`：标题/价值700，其它400；使用已确认的本机 `msyhbd.ttc` / `msyh.ttc`，禁止伪粗体与字体回退。暖白=`#F6F3EC`；次级灰=`#A9A6A0`；唯一彩色为品牌橙 `#FFB13B → #FF7816 → #FF3D00`。正文不使用渐变、描边、投影。静态稿无交互、动效或响应式重排；预览仅整页等比缩小。

标志只读源：`assets/brand/gitrader-wordmark.svg`（仓库根相对路径）。以原文件字节的 data URI 嵌入，保持矢量；不得重描、改路径、删原背景、换字重/字距/颜色或把 logo 交给生成器。源文件不得修改。

## 主视觉与边界

Imagegen 只生成独立无字场景；目标3:2、优先1536×1024。深灰阳极氧化石墨底座上，恰好三枚同尺寸家族的插件模块沿共同对接平面并列装入；模块正面少量深烟玻璃，金属框体为主体。摄像机轻微右侧三分之四、俯角约25°，长焦式克制透视。低矮底座承托明确，每枚模块有实际接触阴影；不悬浮、不穿模、不像三部手机。

原图归一化坐标：模块+底座+可见阴影限制在 x8%–92%、y12%–88%；顶部0–8%、底部92%–100%、左右0–6%及94%–100%为透明留空区。模块轮廓在黑底清楚，橙只在低矮插槽及局部接触反光中出现，彩色总面积不超过画面约5%；倒角细、光源大而软、不大片自发光。

接缝裁决：hero-v1 的暗部虽通过±6数值准入，实际合成出现可见矩形接缝，故原黑底 hero 不再用于最终排版。唯一批准例外是以内置 Imagegen 编辑现有 `hero-v1.png`、设置 `transparent_background=true`，生成独立 `hero-v2-alpha.png`；不得从零重设计。保留三模块、底座、位置、画幅、相机、材质、橙光及接触阴影，只去除背景；原 hero-v1 不动。不透明场景/RGB边缘容差门禁由以下 alpha 门禁取代。

alpha 门禁分为试合成与最终验收：须为真实 RGBA PNG，1536×1024，非棋盘格/纯色冒充透明；三组件及底座可辨、构图保留即可先按原版式试合成。主体应呈有效不透明的实心材质，alpha 254（约99.6%）与255均可；不要求出现255，不因最大值254或外边少量非零alpha单独判失败，也不要求为生成预览先通过最终视觉验收。hero-v2-alpha 已目视确认完整三组件和位置，允许立即进入试合成。最终须在规定黑底的合成 PNG 100%原尺寸检查四边和物体轮廓：留空区视觉透明，主体无透底/材质稀释，接触阴影自然局部衰减，且无矩形边界、可见灰/黑 halo、缺边或被挖空的深色金属。不得因提取背景改变三模块造型；若出现灰雾/halo，应展示合成证据并交回设计裁决，不能以试合成获准替代最终通过。

将满足试合成条件的 hero-v2-alpha 原文件按表中相同坐标、尺寸及原有黑底等比嵌入，排版一项不动；最终视觉门禁在合成后执行。除此明确 Imagegen 背景提取例外外，禁止任何手工/脚本 mask、补色、调色、锐化、重画或后处理；不得再改变生成结果。禁止拉伸、裁掉实体/阴影或越出视口。海报 y0–1168 与 y2600–3072 除规定文字/logo外必须纯黑无视觉溢出；最终海报 PNG 仍不透明。不额外标 AGENT/ENGINE/VENUE。

## 当前 Imagegen 编辑 prompt（英文原样使用）

Edit the supplied hero-v1 image only to extract its existing assembly onto a genuinely transparent background. Preserve the original 1536 by 1024 canvas, exact framing, camera perspective, scale and positions, all three graphite modules, the complete docking foundation, fine bevels, smoked-glass and metal materials, orange light guides, highlights and surface details. Do not redesign, rearrange, crop, enlarge or add anything. Remove the entire near-black studio background and floor outside the assembly. Preserve believable contact shadows immediately beneath the foundation as soft, localized semi-transparent neutral shadows that fade to zero alpha, not as an opaque dark floor or rectangular patch. Keep every dark metal surface solid; do not confuse black object details or recesses with the background. Keep clean antialiased silhouette edges with no gray fringe or residual black matte. All empty outer margins must have zero alpha. Return a true RGBA PNG with transparency, not a checkerboard pattern, white background or black background. The cutout will be placed on #0A0A0B; it must have no visible rectangular boundary. No text, logo, watermark, new objects or other changes.

## 原始生成 prompt（已执行留档，不作为本次编辑指令）

Create one premium photorealistic 3D product-visualization image, landscape 3:2, preferably 1536 by 1024 pixels. This is a text-free visual metaphor for composable agent-trading software infrastructure, not a real hardware product and not a complete poster. Do not generate any typography, logos, symbols or labels.

Show a single bespoke, low-profile precision docking foundation carrying exactly three separate plug-in modules from the same industrial design family. The three modules are assembled side by side into aligned receptacles on one common docking plane. They are compact machined components, not smartphones, server racks, cubes or towers. Each has an anodized graphite metal chassis, a restrained dark smoked-glass inset and very fine, consistent bevels. All three have believable physical contact with the foundation, precise alignment, clean seams and delicate contact shadows. No levitation, no exploded view, no impossible intersections. Keep the entire assembly readable as one coherent modular system.

Use a slightly right-hand three-quarter camera, about 25 degrees looking down, with a compressed premium studio-product perspective and sharp material detail. Soft large-area warm-neutral key light reveals dark charcoal faces and subtle edge highlights. A thin recessed amber-to-orange light guide inside the low docking slot is the only colored light: #FFB13B through #FF7816 to #FF3D00. Restrict warm spill to the immediate contact surfaces. Colored luminous areas occupy less than approximately five percent of the image. No bloom clouds or blown-out highlights. The foundation is wide, low and visually grounded, not a glowing pedestal.

Use an uninterrupted flat near-black studio background, #0A0A0B, with no horizon. Keep the complete assembly and its visible shadows within x=8–92 percent and y=12–88 percent of the frame. The top 8 percent, bottom 8 percent, left 6 percent and right 6 percent MUST remain completely empty uniform near-black, with no texture, shadow, glow, vignette, fog or object. Preserve generous negative space and every outer edge of the assembly.

Refined enterprise Web3 infrastructure mood: quiet, precise, tactile and credible. No coins, currency symbols, candlesticks, charts, bulls, rockets, shields, padlocks, circuit-board patterns, energy beams, wires, particles, grids, science-fiction city, rainbow, purple or blue accents. No cartoon treatment, ornament, signage, watermark or additional objects. Render only the standalone unlettered assembly scene.

## 执行与验收

施工所有权仅本目录（字体隔离运行目录为上述临时例外）；Luna 按当前编辑 prompt 调用 Imagegen，检查真实 alpha/三模块/原构图，再按不变排版生成 `poster.svg`、`poster.png`（2048×3072）和 `poster-preview.png`（1024×1536），保留 hero-v1、hero-v2-alpha、实际 prompt、可复跑脚本与源文件哈希记录。无 URL 外链依赖，但存在已说明的本机字体依赖；不改品牌源或应用，不提交/打包/发布。依赖、字体、数量或画面边界不符时停止交回，不自行更换方向。

独立审验：比对嵌入 logo 与源 SHA；核对全部文案、字号/坐标/字体来源、像素尺寸；检查一览图与100%细节图。logo 为前置品牌锚点，三秒主要内容读序须为标题→模块→价值，正文完整无缺字/重叠/裁切；主视觉通过上述 alpha 与合成门禁、橙光无污染、三模块无融合。禁止收益/客户数字、全资产上线暗示、交易所 logo/合作背书、竞品名、策略/行情供给或托管宣传。页脚必须保留开发中状态；验收不以施工员自报为证据。
