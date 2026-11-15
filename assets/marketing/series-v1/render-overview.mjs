import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(scriptPath);
const nodeModules = path.resolve(path.dirname(process.execPath), "../node_modules");
const require = createRequire(path.join(nodeModules, "_overview-renderer.cjs"));
const dirs = ["01-stocks", "02-crypto", "03-metals", "04-diy", "05-pro", "06-paper"];
const labels = ["01 美股", "02 加密", "03 贵金属", "04 DIY", "05 专业开放", "06 模拟起步"];
const xs = [48, 584, 1120], ys = [48, 936], labelYs = [832, 1720];
const files = dirs.map((dir) => ({ dir, png: path.join(root, dir, "poster.png"), preview: path.join(root, dir, "poster-preview.png"), manifest: path.join(root, dir, "MANIFEST.json") }));
const output = path.join(root, "overview.png"), manifestPath = path.join(root, "MANIFEST.json");
const fontSources = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"];
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function renderChild() {
  const sharp = require("sharp");
  if (process.argv[2] !== "--child") throw new Error("Unknown child mode.");
  const composites = [];
  for (let i = 0; i < files.length; i++) {
    const meta = await sharp(files[i].png).metadata();
    if (meta.width !== 2048 || meta.height !== 3072) throw new Error(`${files[i].dir} poster must be 2048x3072.`);
    composites.push({ input: await sharp(files[i].png).resize(496, 744, { fit: "fill", kernel: "lanczos3" }).png().toBuffer(), left: xs[i % 3], top: ys[Math.floor(i / 3)] });
  }
  const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1664" height="1792" viewBox="0 0 1664 1792"><g font-family="Microsoft YaHei" font-size="24" font-weight="400" fill="#A9A6A0">${labels.map((label, i) => `<text x="${xs[i % 3]}" y="${labelYs[Math.floor(i / 3)]}">${xml(label)}</text>`).join("")}</g></svg>`;
  composites.push({ input: Buffer.from(textSvg), left: 0, top: 0 });
  const png = await sharp({ create: { width: 1664, height: 1792, channels: 3, background: "#0A0A0B" } }).composite(composites).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(output, png);
  const meta = await sharp(png).metadata();
  const result = { sharp: sharp.versions.sharp, overview: { bytes: png.length, sha256: sha256(png), width: meta.width, height: meta.height } };
  await fs.writeFile(process.env.OVERVIEW_RESULT_FILE, JSON.stringify(result));
}

async function setupFonts() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "gitrader-overview-fonts-"));
  const fontDir = path.join(temp, "fonts"), cacheDir = path.join(temp, "cache");
  await fs.mkdir(fontDir); await fs.mkdir(cacheDir);
  const fontFiles = [];
  for (const source of fontSources) {
    const data = await fs.readFile(source);
    await fs.copyFile(source, path.join(fontDir, path.basename(source)));
    fontFiles.push({ file: path.basename(source), bytes: data.length, sha256: sha256(data) });
  }
  const configPath = path.join(temp, "fonts.conf");
  const norm = (s) => s.replaceAll("\\", "/");
  await fs.writeFile(configPath, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><reset-dirs/><dir>${xml(norm(fontDir))}</dir><cachedir>${xml(norm(cacheDir))}</cachedir></fontconfig>\n`);
  return { temp, configPath, fontFiles };
}

if (process.argv[2] === "--child") {
  await renderChild();
} else {
  const layout = JSON.parse(await fs.readFile(path.join(root, "layout.json"), "utf8"));
  const overview = layout.overview;
  if (overview.width !== 1664 || overview.height !== 1792 || overview.thumbnailWidth !== 496 || overview.thumbnailHeight !== 744) throw new Error("Overview layout differs from the approved contract.");
  if (dirs.some((dir, i) => layout.posters[i]?.directory !== dir || layout.posters[i]?.overviewLabel !== labels[i])) throw new Error("Poster order or labels differ from layout.json.");
  const itemData = [];
  for (let i = 0; i < files.length; i++) {
    const [png, preview, childManifest] = await Promise.all([fs.readFile(files[i].png), fs.readFile(files[i].preview), fs.readFile(files[i].manifest, "utf8")]);
    const cm = JSON.parse(childManifest);
    itemData.push({ id: layout.posters[i].id, directory: files[i].dir, label: labels[i], poster: { file: `${files[i].dir}/poster.png`, bytes: png.length, sha256: sha256(png), width: cm.outputs["poster.png"].width, height: cm.outputs["poster.png"].height }, preview: { file: `${files[i].dir}/poster-preview.png`, bytes: preview.length, sha256: sha256(preview), width: cm.outputs["poster-preview.png"].width, height: cm.outputs["poster-preview.png"].height }, sourceScene: cm.sourceScene });
  }
  const font = await setupFonts();
  try {
    const resultPath = path.join(font.temp, "overview-result.json");
    const env = { ...process.env, FONTCONFIG_FILE: font.configPath, FONTCONFIG_PATH: font.temp, FC_DEBUG: "1060", OVERVIEW_RESULT_FILE: resultPath };
    const run = spawnSync(process.execPath, [scriptPath, "--child"], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`Overview render failed (${run.status}): ${run.stderr.slice(-1200)}`);
    const lines = (run.stdout + "\n" + run.stderr).split(/\r?\n/);
    const fontEvidence = ["msyh.ttc", "msyhbd.ttc"].map((name) => {
      const i = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase()));
      const context = i < 0 ? [] : lines.slice(Math.max(0, i - 14), i + 2);
      const pick = (prefix) => context.find((line) => line.trimStart().startsWith(prefix))?.trim() ?? null;
      return { file: name, loaded: i >= 0, family: pick("family:"), style: pick("style:"), weight: pick("weight:") };
    });
    if (!fontEvidence.every((face) => face.loaded && face.family && face.style && face.weight)) throw new Error("Could not verify isolated Microsoft YaHei regular face for overview labels.");
    const outputData = JSON.parse(await fs.readFile(resultPath, "utf8"));
    const manifest = { contract: { source: "BLUEPRINT.md", canvas: overview, background: "#0A0A0B", order: dirs, labels, thumbnailPositions: { xs, ys }, labelBaselines: { xs, ys: labelYs }, labelStyle: { family: "Microsoft YaHei", size: 24, weight: 400, fill: "#A9A6A0" } }, typography: { isolatedFontconfig: true, fontFiles: font.fontFiles, renderEvidence: fontEvidence }, posters: itemData, output: { file: "overview.png", ...outputData.overview }, sharp: outputData.sharp, renderExitCode: run.status };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ exitCode: run.status, output: manifest.output, fontEvidence, posters: itemData.map((item) => ({ directory: item.directory, sha256: item.poster.sha256 })) }, null, 2));
  } finally { await fs.rm(font.temp, { recursive: true, force: true }); }
}
