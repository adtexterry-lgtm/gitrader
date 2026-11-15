import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const id = "06";
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(dir);
// 仓库根由脚本位置推导（<repo>/assets/marketing/series-v1/<id>/），公开仓库不留本机绝对路径。
const repoRoot = path.resolve(root, "../../..");
const nodeModules = path.resolve(path.dirname(process.execPath), "../node_modules");
const require = createRequire(path.join(nodeModules, "_poster-renderer.cjs"));
const f = { scene: path.join(dir, "scene.png"), svg: path.join(dir, "poster.svg"), png: path.join(dir, "poster.png"), preview: path.join(dir, "poster-preview.png"), manifest: path.join(dir, "MANIFEST.json"), layout: path.join(root, "layout.json"), prompts: path.join(root, "PROMPTS.md"), logo: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.svg") };
const fontSources = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"];
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex").toUpperCase();
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function child() {
  const sharp = require("sharp");
  const png = await sharp(await fs.readFile(f.svg)).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(f.png, png);
  const preview = await sharp(png).resize(1024, 1536, { fit: "fill", kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(f.preview, preview);
  await fs.writeFile(process.env.POSTER_RESULT_FILE, JSON.stringify({ sharp: sharp.versions.sharp, poster: { bytes: png.length, sha256: hash(png), width: 2048, height: 3072 }, preview: { bytes: preview.length, sha256: hash(preview), width: 1024, height: 1536 } }));
}

async function fontIsolation() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "gitrader-series-fonts-"));
  const fonts = path.join(temp, "fonts"), cache = path.join(temp, "cache");
  await fs.mkdir(fonts); await fs.mkdir(cache);
  const copies = [];
  for (const source of fontSources) { const b = await fs.readFile(source); await fs.copyFile(source, path.join(fonts, path.basename(source))); copies.push({ file: path.basename(source), bytes: b.length, sha256: hash(b) }); }
  const config = path.join(temp, "fonts.conf");
  await fs.writeFile(config, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><reset-dirs/><dir>${esc(fonts.replaceAll("\\", "/"))}</dir><cachedir>${esc(cache.replaceAll("\\", "/"))}</cachedir></fontconfig>\n`);
  return { temp, config, copies };
}

function render(font) {
  const resultPath = path.join(font.temp, "result.json");
  const env = { ...process.env, FONTCONFIG_FILE: font.config, FONTCONFIG_PATH: font.temp, FC_DEBUG: "1060", POSTER_RESULT_FILE: resultPath };
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  const lines = (run.stdout + "\n" + run.stderr).split(/\r?\n/);
  const evidence = ["msyh.ttc", "msyhbd.ttc"].map((name) => { const i = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase())); if (i < 0) return { file: name, loaded: false }; const c = lines.slice(Math.max(0, i - 14), i + 2); const pick = (p) => c.find((line) => line.trimStart().startsWith(p))?.trim() ?? null; return { file: name, loaded: true, family: pick("family:"), style: pick("style:"), weight: pick("weight:") }; });
  let payload = null; try { payload = JSON.parse(require("node:fs").readFileSync(resultPath, "utf8")); } catch {}
  return { run, evidence, payload };
}

if (process.argv[2] === "--child") await child();
else {
  const [layout, scene, logo, prompts] = await Promise.all([fs.readFile(f.layout, "utf8").then(JSON.parse), fs.readFile(f.scene), fs.readFile(f.logo), fs.readFile(f.prompts, "utf8")]);
  const p = layout.posters.find((x) => x.id === id);
  if (!p) throw new Error(`Poster ${id} is missing from layout.json.`);
  const sharp = require("sharp"), meta = await sharp(scene).metadata();
  if (meta.width * 3 !== meta.height * 2) throw new Error(`Scene ratio ${meta.width}:${meta.height} is not 2:3.`);
  const promptText = prompts.split(`## ${p.directory}`)[1]?.split("\n## ")[0];
  if (!promptText) throw new Error(`Prompt section ${p.directory} is missing.`);
  const s = layout.slots, colors = layout.colors, text = [];
  const add = (value, x, y, size, weight, fill, spacing = 0) => text.push(`<text x="${x}" y="${y}" font-family="Microsoft YaHei" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="start" dominant-baseline="alphabetic" letter-spacing="${spacing}">${esc(value)}</text>`);
  add(p.eyebrow, s.eyebrow.x, s.eyebrow.y, s.eyebrow.fontSize, s.eyebrow.fontWeight, colors[s.eyebrow.fillToken], s.eyebrow.letterSpacing);
  p.title.forEach((v, i) => add(v, s.title.x, s.title.ys[i], s.title.fontSize, s.title.fontWeight, colors[s.title.fillToken]));
  p.support.forEach((v, i) => add(v, s.support.x, s.support.ys[i], s.support.fontSize, s.support.fontWeight, colors[s.support.fillToken]));
  add(p.sceneLabel, s.sceneLabel.x, s.sceneLabel.y, s.sceneLabel.fontSize, s.sceneLabel.fontWeight, colors[s.sceneLabel.fillToken]);
  add(p.shortTag, s.shortTag.x, s.shortTag.y, s.shortTag.fontSize, s.shortTag.fontWeight, colors[s.shortTag.fillToken]);
  p.benefits.forEach((v, i) => add(v, s.benefits.xs[i], s.benefits.y, s.benefits.fontSize, s.benefits.fontWeight, colors[s.benefits.fillToken]));
  add(p.cta, s.cta.x, s.cta.y, s.cta.fontSize, s.cta.fontWeight, colors[s.cta.fillToken]);
  add(layout.footer, s.footer.x, s.footer.y, s.footer.fontSize, s.footer.fontWeight, colors[s.footer.fillToken]);
  if (text.length !== 12) throw new Error(`Expected 12 native text nodes; found ${text.length}.`);
  const stops = layout.blackOverlay.stops.map((v) => `<stop offset="${v.y / layout.canvas.height * 100}%" stop-color="${layout.blackOverlay.color}" stop-opacity="${v.opacity}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="3072" viewBox="0 0 2048 3072"><defs><linearGradient id="black-overlay" x1="0" y1="0" x2="0" y2="3072" gradientUnits="userSpaceOnUse">${stops}</linearGradient></defs><rect width="2048" height="3072" fill="${colors.background}"/><image x="0" y="0" width="2048" height="3072" preserveAspectRatio="none" href="data:image/png;base64,${scene.toString("base64")}"/><rect width="2048" height="3072" fill="url(#black-overlay)"/><image x="${layout.brand.x}" y="${layout.brand.y}" width="${layout.brand.width}" height="${layout.brand.height}" href="data:image/svg+xml;base64,${logo.toString("base64")}"/>${text.join("")}</svg>`;
  await fs.writeFile(f.svg, svg, "utf8");
  const font = await fontIsolation();
  try {
    const r = render(font);
    if (r.run.status !== 0) throw new Error(`Sharp child exited ${r.run.status}: ${r.run.stderr.slice(-1000)}`);
    if (!r.payload) throw new Error("Renderer did not return metadata.");
    const manifest = { poster: { id: p.id, directory: p.directory, title: p.title, textNodes: 12, canvas: layout.canvas, preview: layout.preview }, promptSource: `../PROMPTS.md#${p.directory}`, promptSectionSha256: hash(Buffer.from(promptText)), scene: { file: "scene.png", sourceWidth: meta.width, sourceHeight: meta.height, format: meta.format, channels: meta.channels, bytes: scene.length, sha256: hash(scene), embeddedOriginalBytes: true }, brand: { source: layout.brand.source, bytes: logo.length, sha256: hash(logo), embeddedOriginalBytes: true }, typography: { family: layout.font.family, weights: layout.font.weights, isolatedFontconfig: true, localFontCopies: font.copies, fcDebug: "1060", renderEvidence: r.evidence }, outputs: { "poster.svg": { bytes: Buffer.byteLength(svg), sha256: hash(Buffer.from(svg)) }, "poster.png": r.payload.poster, "poster-preview.png": r.payload.preview } };
    await fs.writeFile(f.manifest, JSON.stringify(manifest, null, 2) + "\n");
    console.log(JSON.stringify({ exitCode: r.run.status, textNodes: text.length, outputs: r.payload, fontEvidence: r.evidence }, null, 2));
  } finally { await fs.rm(font.temp, { recursive: true, force: true }); }
}
