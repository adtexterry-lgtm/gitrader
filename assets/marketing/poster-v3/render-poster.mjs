import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const outDir = path.dirname(scriptPath);
// 仓库根由脚本自身位置推导（本文件在 <repo>/assets/marketing/poster-v3/），公开仓库不留本机绝对路径。
const repoRoot = path.resolve(outDir, "../../..");
const nodeModules = path.resolve(path.dirname(process.execPath), "../node_modules");
const require = createRequire(path.join(nodeModules, "_poster-renderer.cjs"));
const args = process.argv.slice(2);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const files = {
  scene: path.join(outDir, "scene-v2.png"),
  sourceSvg: path.join(outDir, "..", "poster-v2", "poster.svg"),
  logo: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.svg"),
  svg: path.join(outDir, "poster.svg"),
  png: path.join(outDir, "poster.png"),
  preview: path.join(outDir, "poster-preview.png"),
  manifest: path.join(outDir, "MANIFEST.json"),
};
const fonts = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"];
const mappings = [
  ["AGENT TRADING INFRASTRUCTURE", "YOUR AI. YOUR TRADING SYSTEM."],
  ["接入你自己的智能体、策略引擎与交易场所。", "智能体、策略引擎、交易场所，按你的想法组合。"],
  ["策略与数据由你掌握，执行权限由你设定。", "策略由你选择，权限由你设定，行动有据可查。"],
  ["K 线行情 · 订单簿", "K 线行情 · 订单簿"],
  ["交易界面概念示意 · 非实时行情", "交易界面概念示意 · 非实时行情"],
  ["通过 MCP 接入智能体，连接任意语言引擎。", "用 MCP 接入你的 AI，连接自选引擎与场所。"],
  ["只读、纸面、需确认、限额自动，按需授权。", "只读、纸面、需确认、限额自动，四档由你选。"],
  ["记录来源、动作与风控判断，支持导出与核验。", "谁在操作、为何执行、风控如何判断，清楚可查。"],
  ["开源底座 · M1 开发中", "开源底座 · M1 开发中"],
  ["策略与数据自有 · 资金不托管", "策略与数据自有 · 资金不托管"],
  ["AI 交易的", "让你的 AI"],
  ["可组合底座", "拥有交易能力"],
  ["自由接入", "自由组合"],
  ["四档权限", "你来授权"],
  ["操作留痕", "看清行动"],
  ["自有 Agent", "你的 AI"],
  ["MCP 接入", "由你接入"],
  ["自有策略", "你的策略"],
  ["连接自有引擎", "连接你的引擎"],
];

async function renderChild() {
  const sharp = require("sharp");
  if (args[1] !== "--render") throw new Error("Unknown renderer child mode.");
  const poster = await sharp(await fs.readFile(args[2])).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(args[3], poster);
  const preview = await sharp(poster).resize(1024, 1536, { fit: "fill", kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(args[4], preview);
  await fs.writeFile(process.env.POSTER_RESULT_FILE, JSON.stringify({
    sharp: sharp.versions.sharp,
    poster: { bytes: poster.length, sha256: sha256(poster), width: 2048, height: 3072 },
    preview: { bytes: preview.length, sha256: sha256(preview), width: 1024, height: 1536 },
  }));
}

async function isolateFonts() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrader-poster-v3-fonts-"));
  const fontDir = path.join(root, "fonts");
  const cacheDir = path.join(root, "cache");
  await fs.mkdir(fontDir);
  await fs.mkdir(cacheDir);
  const copies = [];
  for (const source of fonts) {
    const target = path.join(fontDir, path.basename(source));
    const bytes = await fs.readFile(source);
    await fs.copyFile(source, target);
    copies.push({ file: path.basename(source), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const configPath = path.join(root, "fonts.conf");
  const config = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><reset-dirs/><dir>${xml(fontDir.replaceAll("\\", "/"))}</dir><cachedir>${xml(cacheDir.replaceAll("\\", "/"))}</cachedir></fontconfig>\n`;
  await fs.writeFile(configPath, config, "utf8");
  return { root, configPath, copies };
}

function isolatedRender(configPath, root) {
  const resultPath = path.join(root, "result.json");
  const env = { ...process.env, FONTCONFIG_FILE: configPath, FONTCONFIG_PATH: root, FC_DEBUG: "1060", POSTER_RESULT_FILE: resultPath };
  const run = spawnSync(process.execPath, [scriptPath, "--child", "--render", files.svg, files.png, files.preview], {
    env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const lines = (run.stdout + "\n" + run.stderr).split(/\r?\n/);
  const evidence = ["msyh.ttc", "msyhbd.ttc"].map((name) => {
    const i = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase()));
    if (i < 0) return { file: name, loaded: false };
    const context = lines.slice(Math.max(0, i - 14), i + 2);
    const pick = (prefix) => context.find((line) => line.trimStart().startsWith(prefix))?.trim() ?? null;
    return { file: name, loaded: true, family: pick("family:"), style: pick("style:"), weight: pick("weight:") };
  });
  let payload = null;
  try { payload = JSON.parse(require("node:fs").readFileSync(resultPath, "utf8")); } catch {}
  return { run, evidence, payload };
}

if (args[0] === "--child") {
  await renderChild();
} else {
  const [sourceBytes, sceneBytes, logoBytes] = await Promise.all([
    fs.readFile(files.sourceSvg), fs.readFile(files.scene), fs.readFile(files.logo),
  ]);
  const sourceSvg = sourceBytes.toString("utf8");
  if (!sourceSvg.includes(sceneBytes.toString("base64"))) throw new Error("V2 embedded scene and V3 scene copy differ; stopping.");
  if (!sourceSvg.includes(logoBytes.toString("base64"))) throw new Error("V2 embedded logo and brand source differ; stopping.");
  let index = 0;
  let changed = 0;
  const svg = sourceSvg.replace(/(<text\b[^>]*>)([\s\S]*?)(<\/text>)/g, (_match, open, text, close) => {
    const mapping = mappings[index++];
    if (!mapping) throw new Error("V2 contains more text nodes than the approved 19-node map.");
    if (text !== mapping[0]) throw new Error(`Text node ${index} differs from the approved source; stopping.`);
    if (mapping[0] !== mapping[1]) changed++;
    return open + mapping[1].replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + close;
  });
  if (index !== 19 || mappings.length !== 19 || changed !== 15) throw new Error(`Unexpected mapping counts: nodes=${index}, map=${mappings.length}, changed=${changed}.`);
  await fs.writeFile(files.svg, svg, "utf8");
  const font = await isolateFonts();
  try {
    const result = isolatedRender(font.configPath, font.root);
    if (result.run.status !== 0) throw new Error(`Sharp child failed with ${result.run.status}: ${result.run.stderr.slice(-1200)}`);
    if (!result.payload) throw new Error("Renderer did not return output metadata.");
    const manifest = {
      canvas: { width: 2048, height: 3072, colorSpace: "sRGB", background: "#0A0A0B" },
      copyChange: { source: "../poster-v2/poster.svg", textNodes: 19, changed: 15, preserved: 4, allNonTextBytesPreservedByReplacement: true },
      typography: { family: "Microsoft YaHei", regularWeight: 400, boldWeight: 700, isolatedFontconfig: true, localFontCopies: font.copies, fcDebug: "1060", renderEvidence: result.evidence },
      sources: { sourceSvg: { sha256: sha256(sourceBytes) }, scene: { file: "scene-v2.png", width: 1024, height: 1536, sha256: sha256(sceneBytes) }, logo: { file: "../../brand/gitrader-wordmark.svg", sha256: sha256(logoBytes) } },
      outputs: { "poster.svg": { sha256: sha256(Buffer.from(svg)) }, "poster.png": result.payload.poster, "poster-preview.png": result.payload.preview },
    };
    await fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ phase: "poster-v3-copy-render", exitCode: result.run.status, textNodes: index, changed, preserved: index - changed, outputs: result.payload, fontEvidence: result.evidence }, null, 2));
  } finally {
    await fs.rm(font.root, { recursive: true, force: true });
  }
}
