import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const outDir = path.dirname(scriptPath);
const posterDir = path.basename(outDir);
const nodeModules = path.resolve(path.dirname(process.execPath), "../node_modules");
const require = createRequire(path.join(nodeModules, "_poster-renderer.cjs"));
const args = process.argv.slice(2);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const rootDir = path.resolve(outDir, "..");
// 仓库根由脚本位置推导（<repo>/assets/marketing/series-v1/<id>/），公开仓库不留本机绝对路径。
const repoRoot = path.resolve(rootDir, "../../..");
const files = {
  layout: path.join(rootDir, "layout.json"), prompts: path.join(rootDir, "PROMPTS.md"),
  scene: path.join(outDir, "scene.png"), logo: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.svg"),
  svg: path.join(outDir, "poster.svg"), png: path.join(outDir, "poster.png"),
  preview: path.join(outDir, "poster-preview.png"), manifest: path.join(outDir, "MANIFEST.json"),
};
const fontSources = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"];
const colors = { background: "#0A0A0B", primary: "#F6F3EC", secondary: "#A9A6A0", cta: "#FFB13B" };

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

async function isolatedFonts() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "gitrader-series-fonts-"));
  const fontDir = path.join(temp, "fonts");
  const cacheDir = path.join(temp, "cache");
  await fs.mkdir(fontDir);
  await fs.mkdir(cacheDir);
  const copies = [];
  for (const source of fontSources) {
    const bytes = await fs.readFile(source);
    await fs.copyFile(source, path.join(fontDir, path.basename(source)));
    copies.push({ file: path.basename(source), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const configPath = path.join(temp, "fonts.conf");
  await fs.writeFile(configPath, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><reset-dirs/><dir>${escape(fontDir.replaceAll("\\", "/"))}</dir><cachedir>${escape(cacheDir.replaceAll("\\", "/"))}</cachedir></fontconfig>\n`);
  return { temp, configPath, copies };
}

function runIsolated(configPath, temp) {
  const resultPath = path.join(temp, "render-result.json");
  const env = { ...process.env, FONTCONFIG_FILE: configPath, FONTCONFIG_PATH: temp, FC_DEBUG: "1060", POSTER_RESULT_FILE: resultPath };
  const run = spawnSync(process.execPath, [scriptPath, "--child", "--render", files.svg, files.png, files.preview], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  const lines = (run.stdout + "\n" + run.stderr).split(/\r?\n/);
  const fontEvidence = ["msyh.ttc", "msyhbd.ttc"].map((name) => {
    const i = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase()));
    if (i < 0) return { file: name, loaded: false };
    const context = lines.slice(Math.max(0, i - 14), i + 2);
    const pick = (prefix) => context.find((line) => line.trimStart().startsWith(prefix))?.trim() ?? null;
    return { file: name, loaded: true, family: pick("family:"), style: pick("style:"), weight: pick("weight:") };
  });
  let payload = null;
  try { payload = JSON.parse(require("node:fs").readFileSync(resultPath, "utf8")); } catch {}
  return { run, fontEvidence, payload };
}

const text = (value, x, y, size, weight, fill, tracking = 0) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"${tracking ? ` letter-spacing="${tracking}"` : ""}>${escape(value)}</text>`;

if (args[0] === "--child") {
  await renderChild();
} else {
  const layout = JSON.parse(await fs.readFile(files.layout, "utf8"));
  const poster = layout.posters.find((p) => p.directory === posterDir);
  if (!poster) throw new Error(`No approved poster object for ${posterDir}.`);
  const [sceneBytes, logoBytes, promptDoc] = await Promise.all([fs.readFile(files.scene), fs.readFile(files.logo), fs.readFile(files.prompts, "utf8")]);
  const sceneSize = { width: sceneBytes.readUInt32BE(16), height: sceneBytes.readUInt32BE(20) };
  if (sceneSize.width * 3 !== sceneSize.height * 2) throw new Error(`Expected 2:3 source scene, got ${sceneSize.width}x${sceneSize.height}.`);
  const sceneData = sceneBytes.toString("base64");
  const logoData = logoBytes.toString("base64");
  const promptStart = promptDoc.indexOf(`## ${posterDir}`);
  const nextPrompt = promptDoc.indexOf("\n## ", promptStart + 4);
  if (promptStart < 0) throw new Error(`Missing exact approved prompt section for ${posterDir}.`);
  const promptText = promptDoc.slice(promptStart, nextPrompt < 0 ? undefined : nextPrompt).trim();
  const s = layout.slots;
  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="2048" height="3072" viewBox="0 0 2048 3072" color-interpolation="sRGB">`,
    `<rect width="2048" height="3072" fill="${colors.background}"/>`,
    `<image x="0" y="0" width="2048" height="3072" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${sceneData}" xlink:href="data:image/png;base64,${sceneData}"/>`,
    '<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="3072" gradientUnits="userSpaceOnUse">',
    '<stop offset="0%" stop-color="#0A0A0B" stop-opacity="1"/><stop offset="31.25%" stop-color="#0A0A0B" stop-opacity="1"/><stop offset="35.9375%" stop-color="#0A0A0B" stop-opacity="0"/><stop offset="66.6667%" stop-color="#0A0A0B" stop-opacity="0"/><stop offset="72.9167%" stop-color="#0A0A0B" stop-opacity="1"/><stop offset="100%" stop-color="#0A0A0B" stop-opacity="1"/>',
    '</linearGradient></defs><rect width="2048" height="3072" fill="url(#shade)"/>',
    `<image x="${layout.brand.x}" y="${layout.brand.y}" width="${layout.brand.width}" height="${layout.brand.height}" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${logoData}" xlink:href="data:image/svg+xml;base64,${logoData}"/>`,
    `<g font-family="${layout.font.family}" fill="${colors.secondary}" font-weight="400">`,
    text(poster.eyebrow, s.eyebrow.x, s.eyebrow.y, s.eyebrow.fontSize, 400, colors.secondary, s.eyebrow.letterSpacing),
    text(poster.support[0], s.support.x, s.support.ys[0], s.support.fontSize, 400, colors.secondary),
    text(poster.support[1], s.support.x, s.support.ys[1], s.support.fontSize, 400, colors.secondary),
    text(poster.sceneLabel, s.sceneLabel.x, s.sceneLabel.y, s.sceneLabel.fontSize, 400, colors.secondary),
    text(poster.shortTag, s.shortTag.x, s.shortTag.y, s.shortTag.fontSize, 400, colors.secondary),
    text(layout.footer, s.footer.x, s.footer.y, s.footer.fontSize, 400, colors.secondary),
    '</g>',
    `<g font-family="${layout.font.family}" fill="${colors.primary}" font-weight="700">`,
    text(poster.title[0], s.title.x, s.title.ys[0], s.title.fontSize, 700, colors.primary),
    text(poster.title[1], s.title.x, s.title.ys[1], s.title.fontSize, 700, colors.primary),
    text(poster.benefits[0], s.benefits.xs[0], s.benefits.y, s.benefits.fontSize, 700, colors.primary),
    text(poster.benefits[1], s.benefits.xs[1], s.benefits.y, s.benefits.fontSize, 700, colors.primary),
    text(poster.benefits[2], s.benefits.xs[2], s.benefits.y, s.benefits.fontSize, 700, colors.primary),
    '</g>',
    `<g font-family="${layout.font.family}" fill="${colors.cta}" font-weight="700">${text(poster.cta, s.cta.x, s.cta.y, s.cta.fontSize, 700, colors.cta)}</g>`,
    '</svg>',
    '',
  ].join("\n");
  if ((svg.match(/<text\b/g) ?? []).length !== 12) throw new Error("Series poster must contain exactly 12 native text nodes.");
  await fs.writeFile(files.svg, svg, "utf8");
  const font = await isolatedFonts();
  try {
    const rendered = runIsolated(font.configPath, font.temp);
    if (rendered.run.status !== 0) throw new Error(`Sharp render failed (${rendered.run.status}): ${rendered.run.stderr.slice(-1000)}`);
    if (!rendered.payload) throw new Error("Renderer did not return output metadata.");
    if (!rendered.fontEvidence.every((face) => face.loaded && face.family && face.style && face.weight)) throw new Error("Could not verify both isolated Microsoft YaHei faces.");
    const manifest = {
      canvas: layout.canvas,
      sourceScene: { file: "scene.png", ...sceneSize, sha256: sha256(sceneBytes), generatedNative2k: sceneSize.width >= 2048 },
      brand: { source: "../../brand/gitrader-wordmark.svg", sha256: sha256(logoBytes), embeddedOriginalBytes: true },
      prompt: { file: "../PROMPTS.md", section: posterDir, sha256: sha256(Buffer.from(promptText, "utf8")) },
      typography: { family: layout.font.family, weights: layout.font.weights, isolatedFontconfig: true, fontFiles: font.copies, renderEvidence: rendered.fontEvidence },
      outputs: { "poster.svg": { sha256: sha256(Buffer.from(svg)) }, "poster.png": rendered.payload.poster, "poster-preview.png": rendered.payload.preview },
      copy: { headline: poster.title, eyebrow: poster.eyebrow, support: poster.support, sceneLabel: poster.sceneLabel, shortTag: poster.shortTag, benefits: poster.benefits, cta: poster.cta, footer: layout.footer },
    };
    await fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ poster: poster.id, exitCode: rendered.run.status, sourceScene: sceneSize, outputs: rendered.payload, fontEvidence: rendered.fontEvidence }, null, 2));
  } finally {
    await fs.rm(font.temp, { recursive: true, force: true });
  }
}
