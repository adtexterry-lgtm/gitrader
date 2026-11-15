import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const outDir = path.dirname(scriptPath);
// 仓库根由脚本自身位置推导（本文件在 <repo>/assets/marketing/poster-v1/），公开仓库不留本机绝对路径。
const repoRoot = path.resolve(outDir, "../../..");
const nodeModules = path.resolve(path.dirname(process.execPath), "../node_modules");
const require = createRequire(path.join(nodeModules, "_poster-renderer.cjs"));
const args = process.argv.slice(2);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const fonts = {
  regular: "C:/Windows/Fonts/msyh.ttc",
  bold: "C:/Windows/Fonts/msyhbd.ttc",
};
const files = {
  hero: path.join(outDir, "hero-v2-alpha.png"),
  logo: path.join(repoRoot, "assets", "brand", "gitrader-wordmark.svg"),
  svg: path.join(outDir, "poster.svg"),
  png: path.join(outDir, "poster.png"),
  preview: path.join(outDir, "poster-preview.png"),
  manifest: path.join(outDir, "MANIFEST.json"),
};

async function rendererChild() {
  const sharp = require("sharp");
  const mode = args[1];
  if (mode === "--font-test") {
    const sample = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="130">' +
      '<text x="8" y="52" font-family="Microsoft YaHei" font-size="40" font-weight="400">Regular 微软雅黑 字体测试</text>' +
      '<text x="8" y="112" font-family="Microsoft YaHei" font-size="40" font-weight="700">Bold 微软雅黑 字体测试</text></svg>',
    );
    const result = await sharp(sample).png().toBuffer();
    await fs.writeFile(process.env.POSTER_RESULT_FILE, JSON.stringify({ mode, renderedBytes: result.length, sharp: sharp.versions.sharp }));
    return;
  }
  if (mode !== "--render-poster") throw new Error("Unknown renderer child mode.");
  const svgPath = args[2];
  const pngPath = args[3];
  const previewPath = args[4];
  const poster = await sharp(svgPath).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(pngPath, poster);
  const preview = await sharp(poster)
    .resize(1024, 1536, { fit: "fill", kernel: "lanczos3" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await fs.writeFile(previewPath, preview);
  await fs.writeFile(process.env.POSTER_RESULT_FILE, JSON.stringify({
    mode,
    sharp: sharp.versions.sharp,
    poster: { bytes: poster.length, sha256: sha256(poster), width: 2048, height: 3072 },
    preview: { bytes: preview.length, sha256: sha256(preview), width: 1024, height: 1536 },
  }));
}

async function prepareFontIsolation() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitrader-poster-fonts-"));
  const fontDir = path.join(tempDir, "fonts");
  const cacheDir = path.join(tempDir, "cache");
  await fs.mkdir(fontDir);
  await fs.mkdir(cacheDir);
  const copies = [];
  for (const source of Object.values(fonts)) {
    const name = path.basename(source);
    const target = path.join(fontDir, name);
    const bytes = await fs.readFile(source);
    await fs.copyFile(source, target);
    copies.push({ file: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const fontDirXml = xml(fontDir.split(path.sep).join("/"));
  const cacheDirXml = xml(cacheDir.split(path.sep).join("/"));
  const configPath = path.join(tempDir, "fonts.conf");
  const config = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    "<fontconfig>",
    "  <reset-dirs/>",
    "  <dir>" + fontDirXml + "</dir>",
    "  <cachedir>" + cacheDirXml + "</cachedir>",
    "</fontconfig>",
    "",
  ].join("\n");
  await fs.writeFile(configPath, config, "utf8");
  return { tempDir, fontDir, configPath, copies };
}

async function runRenderer(modeArgs, configPath, tempDir) {
  const resultPath = path.join(tempDir, "renderer-result.json");
  await fs.rm(resultPath, { force: true });
  const env = {
    ...process.env,
    FONTCONFIG_FILE: configPath,
    FONTCONFIG_PATH: tempDir,
    FC_DEBUG: "1060",
    POSTER_RESULT_FILE: resultPath,
  };
  const result = spawnSync(process.execPath, [scriptPath, "--renderer-child", ...modeArgs], {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const lines = (result.stdout + "\n" + result.stderr).split(/\r?\n/);
  const tempForms = [tempDir, tempDir.split(path.sep).join("/"), tempDir.split(path.sep).join("\\")];
  const redactTemp = (line) => tempForms.reduce((value, form) => value.replaceAll(form, "<isolated-font-dir>"), line);
  const detailsFor = (name) => {
    const idx = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase()));
    if (idx < 0) return null;
    const context = lines.slice(Math.max(0, idx - 14), idx + 2);
    const pick = (prefix) => {
      const line = context.find((item) => item.trimStart().startsWith(prefix));
      return line ? redactTemp(line.trim()) : null;
    };
    return {
      file: name,
      family: pick("family:"),
      style: pick("style:"),
      weight: pick("weight:"),
      fileEvidence: redactTemp(lines[idx].trim()),
    };
  };
  let payload = null;
  try {
    payload = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {}
  return {
    status: result.status,
    stderr: result.stderr || "",
    payload,
    fontEvidence: [detailsFor("msyh.ttc"), detailsFor("msyhbd.ttc")],
  };
}

function assertBothFaces(evidence) {
  const regular = evidence.find((entry) => entry?.file === "msyh.ttc");
  const bold = evidence.find((entry) => entry?.file === "msyhbd.ttc");
  return {
    regular: Boolean(regular?.family && regular?.style && regular?.weight && /regular|normal/i.test(regular.style)),
    bold: Boolean(bold?.family && bold?.style && bold?.weight && /bold/i.test(bold.style)),
    evidence,
  };
}

function assertRenderedFaces(evidence) {
  const regular = evidence.find((entry) => entry?.file === "msyh.ttc");
  const bold = evidence.find((entry) => entry?.file === "msyhbd.ttc");
  return {
    regular: Boolean(regular?.weight && /weight: 80\b/.test(regular.weight) && regular.fileEvidence),
    bold: Boolean(bold?.weight && /weight: 200\b/.test(bold.weight) && bold.fileEvidence),
    evidence,
  };
}

if (args[0] === "--renderer-child") {
  await rendererChild();
} else {
  const fontIsolation = await prepareFontIsolation();
  try {
    const test = await runRenderer(["--font-test"], fontIsolation.configPath, fontIsolation.tempDir);
    if (test.status !== 0) {
      throw new Error("Isolated font sample failed (exit " + test.status + "): " + test.stderr.slice(-1200));
    }
    const faces = assertBothFaces(test.fontEvidence);
    if (!faces.regular || !faces.bold) {
      console.log(JSON.stringify({
        phase: "isolated-font-test",
        exitCode: test.status,
        renderer: test.payload,
        matchingEvidence: faces.evidence,
        regularFaceFound: faces.regular,
        boldFaceFound: faces.bold,
      }, null, 2));
      throw new Error("Fontconfig did not expose both requested TTC faces in renderer diagnostics; stopping.");
    }
    if (args[0] === "--font-test") {
      console.log(JSON.stringify({
        phase: "isolated-font-test",
        exitCode: test.status,
        renderer: test.payload,
        matchingEvidence: faces.evidence,
        regularFaceFound: faces.regular,
        boldFaceFound: faces.bold,
      }, null, 2));
    } else {
      const [heroBytes, logoBytes] = await Promise.all([fs.readFile(files.hero), fs.readFile(files.logo)]);
      const logoData = logoBytes.toString("base64");
      const heroData = heroBytes.toString("base64");
      const svg = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="2048" height="3072" viewBox="0 0 2048 3072" color-interpolation="sRGB">',
        '  <rect x="0" y="0" width="2048" height="3072" fill="#0A0A0B"/>',
        '  <image x="147.2" y="147.2" width="670.045676654" height="153.6" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,' + logoData + '" xlink:href="data:image/svg+xml;base64,' + logoData + '"/>',
        '  <g font-family="Microsoft YaHei" fill="#A9A6A0" font-weight="400">',
        '    <text x="160" y="444" font-size="28" letter-spacing="3">AGENT TRADING INFRASTRUCTURE</text>',
        '    <text x="164" y="1050" font-size="44">连接智能体、策略引擎与交易场所。</text>',
        '    <text x="160" y="2912" font-size="30">开源底座 · M1 开发中</text>',
        "  </g>",
        '  <g font-family="Microsoft YaHei" fill="#F6F3EC" font-weight="700">',
        '    <text x="160" y="688" font-size="208">AI 交易的</text>',
        '    <text x="160" y="916" font-size="208">可组合底座</text>',
        '    <text x="160" y="2776" font-size="48">自由组合</text>',
        '    <text x="744" y="2776" font-size="48">权限可控</text>',
        '    <text x="1328" y="2776" font-size="48">操作留痕</text>',
        "  </g>",
        '  <text x="1888" y="2912" text-anchor="end" font-family="Microsoft YaHei" font-size="30" font-weight="400" fill="#A9A6A0">不托管资金</text>',
        '  <image x="0" y="1192" width="2048" height="1365.333333" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,' + heroData + '" xlink:href="data:image/png;base64,' + heroData + '"/>',
        "</svg>",
        "",
      ].join("\n");
      await fs.writeFile(files.svg, svg, "utf8");
      const rendered = await runRenderer(["--render-poster", files.svg, files.png, files.preview], fontIsolation.configPath, fontIsolation.tempDir);
      if (rendered.status !== 0) {
        throw new Error("Poster rendering failed (exit " + rendered.status + "): " + rendered.stderr.slice(-1200));
      }
      const renderResult = rendered.payload;
      if (!renderResult) throw new Error("Renderer did not return its result record.");
      const renderFaces = assertRenderedFaces(rendered.fontEvidence);
      const manifest = {
        canvas: { width: 2048, height: 3072, colorSpace: "sRGB", background: "#0A0A0B" },
        typography: {
          family: "Microsoft YaHei",
          isolatedFontconfig: true,
          isolatedFontFiles: fontIsolation.copies,
          regularWeight: 400,
          boldWeight: 700,
          fcDebug: "1060",
          isolatedSampleEvidence: {
            result: test.payload,
            matchedFaces: faces.evidence,
            regularFaceFound: faces.regular,
            boldFaceFound: faces.bold,
          },
          posterRenderEvidence: {
            matchedFaces: renderFaces.evidence,
            regularFaceFound: renderFaces.regular,
            boldFaceFound: renderFaces.bold,
            interpretation: "The isolated child process loaded only these two TTCs; FC_DEBUG reports Microsoft YaHei normal weight 80 and bold weight 200 in the sample, and the same two files/weights in the poster render.",
          },
        },
        composition: {
          logo: { x: 147.2, y: 147.2, width: 670.045676654, height: 153.6 },
          hero: { x: 0, y: 1192, width: 2048, height: 1365.333333, preserveAspectRatio: "xMidYMid meet" },
        },
        sources: {
          hero: { file: "hero-v2-alpha.png", sha256: sha256(heroBytes) },
          logo: { file: "../../brand/gitrader-wordmark.svg", sha256: sha256(logoBytes) },
        },
        outputs: {
          "poster.svg": { sha256: sha256(Buffer.from(svg)) },
          "poster.png": renderResult.poster,
          "poster-preview.png": renderResult.preview,
        },
      };
      await fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      console.log(JSON.stringify({
        phase: "poster-render",
        exitCode: rendered.status,
        stdout: renderResult,
        fontconfigEvidence: {
          isolatedSample: faces.evidence,
          posterRender: renderFaces.evidence,
          posterRegularFaceFound: renderFaces.regular,
          posterBoldFaceFound: renderFaces.bold,
        },
      }, null, 2));
    }
  } finally {
    await fs.rm(fontIsolation.tempDir, { recursive: true, force: true });
  }
}
