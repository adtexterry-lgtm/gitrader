# Poster V1 独立验收

**审验通过（PASS）**。fresh 验证退出0。源logo `7bd5526f8c439c17bca10a8c37193a6b231884ea0cbdacef05cc2e9a511a1b05`，hero `e0a4ca7ebe67d6d4f1f30dbfba5f9935f24b943fc6f1a5eb978fbb4915394962`；输出PNG `dd81ef2ad20a46f25219caf2cdcbcc097edd7f5857136110bf8017931f9c3bb6`。内嵌logo/hero逐字节一致；品牌源、画布、9条文案排版、manifest及无外链/禁词检查通过。字体隔离仅msyh.ttc/msyhbd.ttc，实际字体哈希吻合；sample与poster均记录Regular 80/Bold 200，renderer先设隔离fontconfig再由子进程加载Sharp。hero alpha实测0–254，外圈1059像素非零且最大alpha仅10；整页与预览目视三模块完整，无矩形接缝、灰黑halo、缺边、裁切或明显材质稀释，读序与小尺寸文字清楚。限制：原图在审验界面显示时缩至1280×1920，未能逐像素1:1目视；字节、alpha和整体视觉证据未发现实际影响。未运行renderer、提交、打包或发布。
