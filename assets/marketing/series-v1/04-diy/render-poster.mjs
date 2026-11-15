import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const posterId = "04";
const dir = path.dirname(fileURLToPath(import.meta.url));
const parent = path.dirname(dir);
// 仓库根由脚本位置推导（<repo>/assets/marketing/series-v1/<id>/），公开仓库不留本机绝对路径。
const repoRoot = path.resolve(parent, "../../..");
const nodeModules = path.resolve(path.dirname(process.execPath), "../node_modules");
const require = createRequire(path.join(nodeModules, "_poster-renderer.cjs"));
const files = {
  scene: path.join(dir, "scene.png"), svg: path.join(dir, "poster.svg"),
  png: path.join(dir, "poster.png"), preview: path.join(dir, "poster-preview.png"),
  manifest: path.join(dir, "MANIFEST.json"), layout: path.join(parent, "layout.json"),
  prompts: path.join(parent, "PROMPTS.md"), logo: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.svg"),
};
const fontFiles = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const tokenColor = (layout, token) => layout.colors[token];

async function renderChild() {
  const sharp = require("sharp");
  const poster = await sharp(await fs.readFile(files.svg)).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(files.png, poster);
  const preview = await sharp(poster).resize(1024, 1536, { fit: "fill", kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(files.preview, preview);
  await fs.writeFile(process.env.POSTER_RESULT_FILE, JSON.stringify({
    sharp: sharp.versions.sharp,
    poster: { bytes: poster.length, sha256: sha256(poster), width: 2048, height: 3072 },
    preview: { bytes: preview.length, sha256: sha256(preview), width: 1024, height: 1536 },
  }));
}

async function isolateFonts() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrader-series-fonts-"));
  const fontDir = path.join(root, "fonts");
  const cacheDir = path.join(root, "cache");
  await fs.mkdir(fontDir);
  await fs.mkdir(cacheDir);
  const copies = [];
  for (const source of fontFiles) {
    const bytes = await fs.readFile(source);
    await fs.copyFile(source, path.join(fontDir, path.basename(source)));
    copies.push({ file: path.basename(source), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const configPath = path.join(root, "fonts.conf");
  const config = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><reset-dirs/><dir>${xml(fontDir.replaceAll("\\", "/"))}</dir><cachedir>${xml(cacheDir.replaceAll("\\", "/"))}</cachedir></fontconfig>\n`;
  await fs.writeFile(configPath, config, "utf8");
  return { root, configPath, copies };
}

function isolatedRender(font) {
  const resultPath = path.join(font.root, "result.json");
  const env = { ...process.env, FONTCONFIG_FILE: font.configPath, FONTCONFIG_PATH: font.root, FC_DEBUG: "1060", POSTER_RESULT_FILE: resultPath };
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", files.svg], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
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

if (process.argv[2] === "--child") {
  await renderChild();
} else {
  const [layout, sceneBytes, logoBytes, promptBytes] = await Promise.all([
    fs.readFile(files.layout, "utf8").then(JSON.parse), fs.readFile(files.scene), fs.readFile(files.logo), fs.readFile(files.prompts),
  ]);
  const poster = layout.posters.find((item) => item.id === posterId);
  if (!poster) throw new Error(`Poster ${posterId} is missing from the approved layout.`);
  const sceneMeta = await require("sharp")(sceneBytes).metadata();
  if (sceneMeta.width * 3 !== sceneMeta.height * 2) throw new Error(`Scene ratio is ${sceneMeta.width}:${sceneMeta.height}; expected 2:3.`);
  const promptText = promptBytes.toString("utf8").split(`## ${poster.directory}`)[1]?.split("\n## ")[0];
  if (!promptText) throw new Error(`Prompt section for ${poster.directory} is missing.`);
  const c = layout.colors;
  const parts = [];
  const textNode = (value, x, y, size, weight, fill, spacing = 0, maxWidth = null) => {
    parts.push(`<text x="${x}" y="${y}" font-family="Microsoft YaHei" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="start" dominant-baseline="alphabetic" letter-spacing="${spacing}"${maxWidth ? ` data-max-width="${maxWidth}"` : ""}>${xml(value)}</text>`);
  };
  const slots = layout.slots;
  textNode(poster.eyebrow, slots.eyebrow.x, slots.eyebrow.y, slots.eyebrow.fontSize, slots.eyebrow.fontWeight, tokenColor(layout, slots.eyebrow.fillToken), slots.eyebrow.letterSpacing);
  poster.title.forEach((text, i) => textNode(text, slots.title.x, slots.title.ys[i], slots.title.fontSize, slots.title.fontWeight, tokenColor(layout, slots.title.fillToken)));
  poster.support.forEach((text, i) => textNode(text, slots.support.x, slots.support.ys[i], slots.support.fontSize, slots.support.fontWeight, tokenColor(layout, slots.support.fillToken)));
  textNode(poster.sceneLabel, slots.sceneLabel.x, slots.sceneLabel.y, slots.sceneLabel.fontSize, slots.sceneLabel.fontWeight, tokenColor(layout, slots.sceneLabel.fillToken));
  textNode(poster.shortTag, slots.shortTag.x, slots.shortTag.y, slots.shortTag.fontSize, slots.shortTag.fontWeight, tokenColor(layout, slots.shortTag.fillToken));
  poster.benefits.forEach((text, i) => textNode(text, slots.benefits.xs[i], slots.benefits.y, slots.benefits.fontSize, slots.benefits.fontWeight, tokenColor(layout, slots.benefits.fillToken), 0, slots.benefits.maxWidthEach));
  textNode(poster.cta, slots.cta.x, slots.cta.y, slots.cta.fontSize, slots.cta.fontWeight, tokenColor(layout, slots.cta.fillToken));
  textNode(layout.footer, slots.footer.x, slots.footer.y, slots.footer.fontSize, slots.footer.fontWeight, tokenColor(layout, slots.footer.fillToken));
  if (parts.length !== 12) throw new Error(`Expected 12 native text nodes, found ${parts.length}.`);
  const prompt = `#${poster.id} ${poster.directory}`;
  const gradStops = layout.blackOverlay.stops.map((stop) => `<stop offset="${(stop.y / layout.canvas.height) * 100}%" stop-color="${layout.blackOverlay.color}" stop-opacity="${stop.opacity}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="3072" viewBox="0 0 2048 3072"><defs><linearGradient id="black-overlay" x1="0" y1="0" x2="0" y2="3072" gradientUnits="userSpaceOnUse">${gradStops}</linearGradient></defs><rect width="2048" height="3072" fill="${c.background}"/><image x="0" y="0" width="2048" height="3072" preserveAspectRatio="none" href="data:image/png;base64,${sceneBytes.toString("base64")}"/><rect width="2048" height="3072" fill="url(#black-overlay)"/><image x="${layout.brand.x}" y="${layout.brand.y}" width="${layout.brand.width}" height="${layout.brand.height}" href="data:image/svg+xml;base64,${logoBytes.toString("base64")}"/>${parts.join("")}</svg>`;
  await fs.writeFile(files.svg, svg, "utf8");
  const font = await isolateFonts();
  try {
    const result = isolatedRender(font);
    if (result.run.status !== 0) throw new Error(`Sharp child exited ${result.run.status}: ${result.run.stderr.slice(-1000)}`);
    if (!result.payload) throw new Error("Renderer did not return output metadata.");
    const manifest = {
      poster: { id: poster.id, directory: poster.directory, title: poster.title, textNodes: 12, canvas: layout.canvas, preview: layout.preview },
      promptSource: `../PROMPTS.md#${poster.directory}`, promptSectionSha256: sha256(Buffer.from(promptText)),
      scene: { file: "scene.png", sourceWidth: sceneMeta.width, sourceHeight: sceneMeta.height, format: sceneMeta.format, channels: sceneMeta.channels, bytes: sceneBytes.length, sha256: sha256(sceneBytes), embeddedOriginalBytes: true },
      brand: { source: layout.brand.source, bytes: logoBytes.length, sha256: sha256(logoBytes), embeddedOriginalBytes: true },
      typography: { family: layout.font.family, weights: layout.font.weights, isolatedFontconfig: true, localFontCopies: font.copies, fcDebug: "1060", renderEvidence: result.evidence },
      outputs: { "poster.svg": { bytes: Buffer.byteLength(svg), sha256: sha256(Buffer.from(svg)) }, "poster.png": result.payload.poster, "poster-preview.png": result.payload.preview },
    };
    await fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ exitCode: result.run.status, textNodes: parts.length, outputs: result.payload, fontEvidence: result.evidence }, null, 2));
  } finally { await fs.rm(font.root, { recursive: true, force: true }); }
}
