import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 仓库根由脚本位置推导；Codex 运行时目录由本机 home 推导（可用 GITRADER_POSTER_RUNTIME_MODULES 覆盖），不写死绝对路径。
const repoRoot = path.resolve(here, "../../..");
const runtimeModules = process.env.GITRADER_POSTER_RUNTIME_MODULES
  ?? path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules");
const require = createRequire(path.join(runtimeModules, "_poster-verifier.cjs"));
const sharp = require("sharp");

const files = {
  svg: path.join(here, "poster.svg"),
  png: path.join(here, "poster.png"),
  preview: path.join(here, "poster-preview.png"),
  hero: path.join(here, "hero-v2-alpha.png"),
  manifest: path.join(here, "MANIFEST.json"),
  renderer: path.join(here, "render-poster.mjs"),
  report: path.join(here, "VERIFICATION.md"),
  logoSvg: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.svg"),
  logoPng: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.png"),
  regularFont: "C:/Windows/Fonts/msyh.ttc",
  boldFont: "C:/Windows/Fonts/msyhbd.ttc",
};
const BASELINE = {
  logoSvg: "7bd5526f8c439c17bca10a8c37193a6b231884ea0cbdacef05cc2e9a511a1b05",
  logoPng: "5bf1a20520203f8ed4da3d54a49fd8b5043379b272f661ebf2c6ab5fb31fbf01",
};
const EXPECTED_TEXT = [
  { text: "AGENT TRADING INFRASTRUCTURE", x: "160", y: "444", size: "28", weight: "400", fill: "#A9A6A0", spacing: "3", anchor: "start" },
  { text: "连接智能体、策略引擎与交易场所。", x: "164", y: "1050", size: "44", weight: "400", fill: "#A9A6A0", spacing: "0", anchor: "start" },
  { text: "开源底座 · M1 开发中", x: "160", y: "2912", size: "30", weight: "400", fill: "#A9A6A0", spacing: "0", anchor: "start" },
  { text: "AI 交易的", x: "160", y: "688", size: "208", weight: "700", fill: "#F6F3EC", spacing: "0", anchor: "start" },
  { text: "可组合底座", x: "160", y: "916", size: "208", weight: "700", fill: "#F6F3EC", spacing: "0", anchor: "start" },
  { text: "自由组合", x: "160", y: "2776", size: "48", weight: "700", fill: "#F6F3EC", spacing: "0", anchor: "start" },
  { text: "权限可控", x: "744", y: "2776", size: "48", weight: "700", fill: "#F6F3EC", spacing: "0", anchor: "start" },
  { text: "操作留痕", x: "1328", y: "2776", size: "48", weight: "700", fill: "#F6F3EC", spacing: "0", anchor: "start" },
  { text: "不托管资金", x: "1888", y: "2912", size: "30", weight: "400", fill: "#A9A6A0", spacing: "0", anchor: "end" },
];

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toLowerCase();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const attrs = (source) => Object.fromEntries([...source.matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)].map((match) => [match[1], match[2]]));
const decodeXml = (text) => text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");

function collectTexts(svg) {
  const result = [];
  const groups = [...svg.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/g)];
  for (const group of groups) {
    const inherited = attrs(group[1]);
    for (const match of group[2].matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      result.push({ ...inherited, ...attrs(match[1]), text: decodeXml(match[2]) });
    }
  }
  const withoutGroups = svg.replace(/<g\b[^>]*>[\s\S]*?<\/g>/g, "");
  for (const match of withoutGroups.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    result.push({ ...attrs(match[1]), text: decodeXml(match[2]) });
  }
  return result;
}

function dataUri(tag, mime) {
  const found = [...tag.matchAll(/(?:href|xlink:href)="([^"]+)"/g)].map((match) => match[1]);
  assert(found.length >= 1 && found.every((value) => value === found[0]), `${mime} href/xlink mismatch`);
  const prefix = `data:${mime};base64,`;
  assert(found[0].startsWith(prefix), `${mime} is not an inline base64 data URI`);
  return Buffer.from(found[0].slice(prefix.length), "base64");
}

function imageStats(raw, info) {
  let alphaMin = 255, alphaMax = 0, alphaZero = 0, alpha254 = 0, alpha255 = 0, outerNonZero = 0, outerMax = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = raw[(y * info.width + x) * info.channels + 3];
      alphaMin = Math.min(alphaMin, alpha); alphaMax = Math.max(alphaMax, alpha);
      if (alpha === 0) alphaZero += 1;
      if (alpha === 254) alpha254 += 1;
      if (alpha === 255) alpha255 += 1;
      const outer = x < info.width * 0.06 || x >= info.width * 0.94 || y < info.height * 0.08 || y >= info.height * 0.92;
      if (outer && alpha > 0) { outerNonZero += 1; outerMax = Math.max(outerMax, alpha); }
    }
  }
  return { alphaMin, alphaMax, alphaZero, alpha254, alpha255, outerNonZero, outerMax, pixels: info.width * info.height };
}

async function run() {
  const [svgBytes, pngBytes, previewBytes, heroBytes, logoSvg, logoPng, manifestBytes, renderer, regularFont, boldFont] = await Promise.all([
    fs.readFile(files.svg), fs.readFile(files.png), fs.readFile(files.preview), fs.readFile(files.hero),
    fs.readFile(files.logoSvg), fs.readFile(files.logoPng), fs.readFile(files.manifest),
    fs.readFile(files.renderer, "utf8"), fs.readFile(files.regularFont), fs.readFile(files.boldFont),
  ]);
  const svg = svgBytes.toString("utf8");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert(sha256(logoSvg) === BASELINE.logoSvg && sha256(logoPng) === BASELINE.logoPng, "approved brand source changed");

  const rootMatch = svg.match(/<svg\b([^>]*)>/);
  assert(rootMatch, "SVG root missing");
  const root = attrs(rootMatch[1]);
  assert(root.width === "2048" && root.height === "3072" && root.viewBox === "0 0 2048 3072", "SVG canvas/viewBox differs");
  assert(/<rect\b[^>]*x="0"[^>]*y="0"[^>]*width="2048"[^>]*height="3072"[^>]*fill="#0A0A0B"/.test(svg), "background differs");
  const imageTags = [...svg.matchAll(/<image\b[^>]*\/>/g)].map((match) => match[0]);
  assert(imageTags.length === 2, `image count expected=2 actual=${imageTags.length}`);
  const logoAttrs = attrs(imageTags[0]);
  const heroAttrs = attrs(imageTags[1]);
  assert(JSON.stringify([logoAttrs.x, logoAttrs.y, logoAttrs.width, logoAttrs.height, logoAttrs.preserveAspectRatio]) === JSON.stringify(["147.2", "147.2", "670.045676654", "153.6", "xMidYMid meet"]), "logo placement differs");
  assert(JSON.stringify([heroAttrs.x, heroAttrs.y, heroAttrs.width, heroAttrs.height, heroAttrs.preserveAspectRatio]) === JSON.stringify(["0", "1192", "2048", "1365.333333", "xMidYMid meet"]), "hero placement differs");
  const embeddedLogo = dataUri(imageTags[0], "image/svg+xml");
  const embeddedHero = dataUri(imageTags[1], "image/png");
  assert(embeddedLogo.equals(logoSvg), "embedded logo bytes differ from approved source");
  assert(embeddedHero.equals(heroBytes), "embedded hero bytes differ from hero-v2-alpha source");

  const actualTexts = collectTexts(svg);
  assert(actualTexts.length === EXPECTED_TEXT.length, `text count expected=${EXPECTED_TEXT.length} actual=${actualTexts.length}`);
  for (const expected of EXPECTED_TEXT) {
    const actual = actualTexts.find((item) => item.text === expected.text);
    assert(actual, `missing text: ${expected.text}`);
    const actualShape = [actual.x, actual.y, actual["font-size"], actual["font-weight"], actual.fill, actual["letter-spacing"] ?? "0", actual["text-anchor"] ?? "start", actual["font-family"]];
    const expectedShape = [expected.x, expected.y, expected.size, expected.weight, expected.fill, expected.spacing, expected.anchor, "Microsoft YaHei"];
    assert(JSON.stringify(actualShape) === JSON.stringify(expectedShape), `text attributes differ: ${expected.text}`);
  }
  const visibleText = actualTexts.map((item) => item.text).join(" ").replace("不托管资金", "");
  const forbidden = ["保证收益", "收益率", "客户案例", "客户数量", "全面上线", "全资产上线", "交易所", "官方合作", "合作背书", "竞品", "提供策略", "策略供给", "提供行情", "行情供给", "托管资金"];
  assert(!forbidden.some((term) => visibleText.includes(term)), "forbidden marketing text present");
  const hrefs = [...svg.matchAll(/(?:href|xlink:href)="([^"]+)"/g)].map((match) => match[1]);
  assert(hrefs.length === 4 && hrefs.every((href) => href.startsWith("data:")), "external href present");

  const [posterMeta, previewMeta, heroMeta, heroRawResult] = await Promise.all([
    sharp(pngBytes).metadata(), sharp(previewBytes).metadata(), sharp(heroBytes).metadata(), sharp(heroBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  assert(posterMeta.width === 2048 && posterMeta.height === 3072, "poster PNG dimensions differ");
  assert(previewMeta.width === 1024 && previewMeta.height === 1536, "preview dimensions differ");
  assert(heroMeta.width === 1536 && heroMeta.height === 1024 && heroMeta.hasAlpha && heroMeta.channels === 4, "hero must be 1536x1024 RGBA");
  const alpha = imageStats(heroRawResult.data, heroRawResult.info);
  assert(alpha.alphaZero > 0 && alpha.alphaMax >= 254 && alpha.alphaZero < alpha.pixels, "hero alpha lacks transparent background or solid subject");

  const outputHashes = { "poster.svg": sha256(svgBytes), "poster.png": sha256(pngBytes), "poster-preview.png": sha256(previewBytes) };
  const sourceHashes = { hero: sha256(heroBytes), logo: sha256(logoSvg) };
  assert(manifest.canvas?.width === 2048 && manifest.canvas?.height === 3072 && manifest.canvas?.background === "#0A0A0B", "manifest canvas differs");
  assert(manifest.sources?.hero?.file === "hero-v2-alpha.png" && manifest.sources.hero.sha256.toLowerCase() === sourceHashes.hero, "manifest hero hash differs");
  assert(manifest.sources?.logo?.sha256.toLowerCase() === sourceHashes.logo, "manifest logo hash differs");
  for (const [name, hash] of Object.entries(outputHashes)) {
    assert(manifest.outputs?.[name]?.sha256?.toLowerCase() === hash, `manifest output hash differs: ${name}`);
  }
  assert(manifest.outputs["poster.png"].width === 2048 && manifest.outputs["poster.png"].height === 3072, "manifest poster dimensions differ");
  assert(manifest.outputs["poster-preview.png"].width === 1024 && manifest.outputs["poster-preview.png"].height === 1536, "manifest preview dimensions differ");

  const typography = manifest.typography;
  assert(typography?.family === "Microsoft YaHei" && typography.isolatedFontconfig === true, "font isolation declaration differs");
  assert(typography.regularWeight === 400 && typography.boldWeight === 700 && typography.fcDebug === "1060", "font weights/debug evidence differs");
  const declaredFonts = typography.isolatedFontFiles;
  assert(Array.isArray(declaredFonts) && declaredFonts.length === 2, "isolated font list must contain exactly two files");
  const expectedFonts = { "msyh.ttc": { bytes: regularFont.length, sha256: sha256(regularFont) }, "msyhbd.ttc": { bytes: boldFont.length, sha256: sha256(boldFont) } };
  for (const item of declaredFonts) {
    const expected = expectedFonts[item.file];
    assert(expected && item.bytes === expected.bytes && item.sha256.toLowerCase() === expected.sha256, `isolated font evidence differs: ${item.file}`);
  }
  for (const evidenceName of ["isolatedSampleEvidence", "posterRenderEvidence"]) {
    const evidence = typography[evidenceName];
    assert(evidence?.regularFaceFound === true && evidence?.boldFaceFound === true, `${evidenceName} missing both faces`);
    assert(Array.isArray(evidence.matchedFaces) && evidence.matchedFaces.length === 2, `${evidenceName} face count differs`);
    const names = evidence.matchedFaces.map((face) => face.file).sort();
    assert(JSON.stringify(names) === JSON.stringify(["msyh.ttc", "msyhbd.ttc"]), `${evidenceName} loaded unexpected font`);
    const regular = evidence.matchedFaces.find((face) => face.file === "msyh.ttc");
    const bold = evidence.matchedFaces.find((face) => face.file === "msyhbd.ttc");
    assert(/weight:\s*80\b/.test(regular.weight) && /msyh\.ttc/.test(regular.fileEvidence), `${evidenceName} regular match differs`);
    assert(/weight:\s*200\b/.test(bold.weight) && /msyhbd\.ttc/.test(bold.fileEvidence), `${evidenceName} bold match differs`);
  }
  const rendererChecks = {
    resetDirs: renderer.includes("<reset-dirs/>"),
    fontconfigEnv: renderer.includes("FONTCONFIG_FILE: configPath") && renderer.includes("FONTCONFIG_PATH: tempDir") && renderer.includes('FC_DEBUG: "1060"'),
    isolatedSpawn: renderer.includes('spawnSync(process.execPath, [scriptPath, "--renderer-child"') && renderer.indexOf('const sharp = require("sharp")') > renderer.indexOf("async function rendererChild()"),
    exactFonts: renderer.includes('regular: "C:/Windows/Fonts/msyh.ttc"') && renderer.includes('bold: "C:/Windows/Fonts/msyhbd.ttc"'),
    approvedHero: renderer.includes('hero: path.join(outDir, "hero-v2-alpha.png")'),
  };
  assert(Object.values(rendererChecks).every(Boolean), "renderer font-isolation logic differs");

  const result = {
    status: "AUTOMATED_PASS_AWAITING_VISUAL",
    sourceHashes: { logoSvg: sourceHashes.logo, logoPng: sha256(logoPng), hero: sourceHashes.hero },
    outputHashes,
    dimensions: { poster: [posterMeta.width, posterMeta.height], preview: [previewMeta.width, previewMeta.height], hero: [heroMeta.width, heroMeta.height] },
    textCount: actualTexts.length,
    embeddedBytesEqual: { logo: true, hero: true },
    fontEvidence: { files: declaredFonts, sampleFaces: typography.isolatedSampleEvidence.matchedFaces.map((face) => [face.file, face.weight]), posterFaces: typography.posterRenderEvidence.matchedFaces.map((face) => [face.file, face.weight]), rendererChecks },
    alpha,
    limitations: ["halo/seam, subject integrity, reading order, and small-size legibility require independent visual inspection"],
  };
  await fs.writeFile(files.report, `# Poster V1 独立验收\n\n**自动门禁通过，待目视裁决**。源logo \`${sourceHashes.logo}\`，hero \`${sourceHashes.hero}\`；输出PNG \`${outputHashes["poster.png"]}\`。内嵌logo/hero字节、画布/文案/排版、manifest与字体隔离证据均通过。alpha min/max=${alpha.alphaMin}/${alpha.alphaMax}，外圈非零=${alpha.outerNonZero}。未运行renderer、未提交或发布。\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

try {
  await run();
} catch (error) {
  await fs.writeFile(files.report, `# Poster V1 独立验收\n\n**未通过（FAIL）**：${error.name}: ${error.message}\n`, "utf8");
  console.error(JSON.stringify({ status: "FAIL", error: `${error.name}: ${error.message}` }));
  process.exitCode = 1;
}
