# 06 模拟起步

Built from the approved series-v1 layout and prompt. The prompt is in `../PROMPTS.md#06-paper`; the generated `scene.png` is an opaque RGB PNG with an actual source size of 1024×1536. It is embedded byte-for-byte and scaled proportionally to the 2048×3072 poster canvas.

`render-poster.mjs` composes the original brand SVG and 12 editable text nodes, then renders the poster and preview with Sharp using isolated Microsoft YaHei regular and bold font files. `MANIFEST.json` records the source and output hashes, dimensions, and font evidence.
