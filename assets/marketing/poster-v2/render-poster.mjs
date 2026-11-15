import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const outDir = path.dirname(scriptPath);
// 仓库根由脚本自身位置推导（本文件在 <repo>/assets/marketing/poster-v2/），公开仓库不留本机绝对路径。
const repoRoot = path.resolve(outDir, "../../..");
const nodeModules = path.resolve(path.dirname(process.execPath), "../node_modules");
const require = createRequire(path.join(nodeModules, "_poster-renderer.cjs"));
const args = process.argv.slice(2);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const files = {
  scene: path.join(outDir, "scene-v2.png"),
  logo: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.svg"),
  svg: path.join(outDir, "poster.svg"),
  png: path.join(outDir, "poster.png"),
  preview: path.join(outDir, "poster-preview.png"),
  manifest: path.join(outDir, "MANIFEST.json"),
};
const fonts = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"];

async function child() {
  const sharp = require("sharp");
  if (args[1] !== "--render") throw new Error("Unknown renderer child mode.");
  const svgBytes = await fs.readFile(args[2]);
  const poster = await sharp(svgBytes).png({ compressionLevel: 9 }).toBuffer();
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrader-poster-v2-fonts-"));
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

function renderIsolated(configPath, root) {
  const resultPath = path.join(root, "result.json");
  const env = { ...process.env, FONTCONFIG_FILE: configPath, FONTCONFIG_PATH: root, FC_DEBUG: "1060", POSTER_RESULT_FILE: resultPath };
  const run = spawnSync(process.execPath, [scriptPath, "--child", "--render", files.svg, files.png, files.preview], {
    env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const lines = (run.stdout + "\n" + run.stderr).split(/\r?\n/);
  const evidence = ["msyh.ttc", "msyhbd.ttc"].map((name) => {
    const index = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase()));
    if (index < 0) return { file: name, loaded: false };
    const context = lines.slice(Math.max(0, index - 14), index + 2);
    const pick = (prefix) => context.find((line) => line.trimStart().startsWith(prefix))?.trim() ?? null;
    return { file: name, loaded: true, family: pick("family:"), style: pick("style:"), weight: pick("weight:") };
  });
  let payload = null;
  try { payload = JSON.parse(require("node:fs").readFileSync(resultPath, "utf8")); } catch {}
  return { run, evidence, payload };
}

function esc(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

if (args[0] === "--child") {
  await child();
} else {
  const [sceneBytes, logoBytes] = await Promise.all([fs.readFile(files.scene), fs.readFile(files.logo)]);
  const sceneData = sceneBytes.toString("base64");
  const logoData = logoBytes.toString("base64");
  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="2048" height="3072" viewBox="0 0 2048 3072" color-interpolation="sRGB">',
    '  <rect width="2048" height="3072" fill="#0A0A0B"/>',
    `  <image x="0" y="0" width="2048" height="3072" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${sceneData}" xlink:href="data:image/png;base64,${sceneData}"/>`,
    '  <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="3072" gradientUnits="userSpaceOnUse">',
    '    <stop offset="0" stop-color="#0A0A0B" stop-opacity="1"/><stop offset="31.25%" stop-color="#0A0A0B" stop-opacity="1"/>',
    '    <stop offset="35.9375%" stop-color="#0A0A0B" stop-opacity="0"/><stop offset="66.6667%" stop-color="#0A0A0B" stop-opacity="0"/>',
    '    <stop offset="72.9167%" stop-color="#0A0A0B" stop-opacity="1"/><stop offset="100%" stop-color="#0A0A0B" stop-opacity="1"/>',
    '  </linearGradient></defs><rect width="2048" height="3072" fill="url(#shade)"/>',
    `  <image x="153.2" y="133.2" width="355.961765722" height="81.6" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${logoData}" xlink:href="data:image/svg+xml;base64,${logoData}"/>`,
    '  <g font-family="Microsoft YaHei" fill="#A9A6A0" font-weight="400">',
    '    <text x="160" y="310" font-size="26" letter-spacing="2">AGENT TRADING INFRASTRUCTURE</text>',
    '    <text x="164" y="842" font-size="44">接入你自己的智能体、策略引擎与交易场所。</text>',
    '    <text x="164" y="916" font-size="44">策略与数据由你掌握，执行权限由你设定。</text>',
    '    <text x="160" y="1080" font-size="30">K 线行情 · 订单簿</text>',
    '    <text x="160" y="2148" font-size="26">交易界面概念示意 · 非实时行情</text>',
    '    <text x="656" y="2320" font-size="38">通过 MCP 接入智能体，连接任意语言引擎。</text>',
    '    <text x="656" y="2480" font-size="38">只读、纸面、需确认、限额自动，按需授权。</text>',
    '    <text x="656" y="2640" font-size="38">记录来源、动作与风控判断，支持导出与核验。</text>',
    '    <text x="160" y="2840" font-size="30">开源底座 · M1 开发中</text>',
    '    <text x="160" y="2920" font-size="28">策略与数据自有 · 资金不托管</text>',
    '  </g>',
    '  <g font-family="Microsoft YaHei" fill="#F6F3EC" font-weight="700">',
    '    <text x="160" y="502" font-size="176">AI 交易的</text><text x="160" y="706" font-size="176">可组合底座</text>',
    '    <text x="160" y="2320" font-size="50">自由接入</text><text x="160" y="2480" font-size="50">四档权限</text><text x="160" y="2640" font-size="50">操作留痕</text>',
    '  </g>',
    '  <g fill="none" stroke="#292623" stroke-width="1"><path d="M160 2400H1888"/><path d="M160 2560H1888"/></g>',
    '  <g font-family="Microsoft YaHei">',
    '    <rect x="160" y="1140" width="320" height="140" rx="16" fill="#141414" fill-opacity="0.94" stroke="#F6F3EC" stroke-opacity="0.14" stroke-width="1.5"/>',
    '    <text x="184" y="1192" font-size="34" font-weight="700" fill="#F6F3EC">自有 Agent</text><text x="184" y="1238" font-size="26" font-weight="400" fill="#A9A6A0">MCP 接入</text>',
    '    <rect x="1560" y="1920" width="328" height="140" rx="16" fill="#141414" fill-opacity="0.94" stroke="#F6F3EC" stroke-opacity="0.14" stroke-width="1.5"/>',
    '    <text x="1584" y="1972" font-size="34" font-weight="700" fill="#F6F3EC">自有策略</text><text x="1584" y="2018" font-size="26" font-weight="400" fill="#A9A6A0">连接自有引擎</text>',
    '  </g>',
    '</svg>',
    '',
  ].join("\n");
  await fs.writeFile(files.svg, svg, "utf8");
  const font = await isolateFonts();
  try {
    const result = renderIsolated(font.configPath, font.root);
    if (result.run.status !== 0) throw new Error(`Sharp child failed with ${result.run.status}: ${result.run.stderr.slice(-1200)}`);
    if (!result.payload) throw new Error("Renderer did not return output metadata.");
    const manifest = {
      canvas: { width: 2048, height: 3072, colorSpace: "sRGB", background: "#0A0A0B" },
      typography: { family: "Microsoft YaHei", regularWeight: 400, boldWeight: 700, isolatedFontconfig: true, localFontCopies: font.copies, fcDebug: "1060", renderEvidence: result.evidence },
      composition: { scene: { file: "scene-v2.png", width: 1024, height: 1536, placement: "full-canvas, preserveAspectRatio=xMidYMid meet" }, logo: { file: "../../brand/gitrader-wordmark.svg", x: 153.2, y: 133.2, width: 355.961765722, height: 81.6, embeddedSourceBytes: true } },
      sources: { scene: { sha256: sha256(sceneBytes) }, logo: { sha256: sha256(logoBytes) } },
      outputs: { "poster.svg": { sha256: sha256(Buffer.from(svg)) }, "poster.png": result.payload.poster, "poster-preview.png": result.payload.preview },
      note: "Conceptual interface artwork; not a screenshot of a live exchange. Scene generated once by built-in imagegen and embedded without image edits.",
    };
    await fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ phase: "poster-v2-render", exitCode: result.run.status, outputs: result.payload, fontEvidence: result.evidence }, null, 2));
  } finally {
    await fs.rm(font.root, { recursive: true, force: true });
  }
}
