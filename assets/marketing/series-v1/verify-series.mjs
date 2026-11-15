import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 仓库根由脚本位置推导（<repo>/assets/marketing/series-v1/）；Codex 运行时目录由本机 home 推导（可用 GITRADER_POSTER_RUNTIME_MODULES 覆盖），不写死绝对路径。
const repoRoot = path.resolve(here, "../../..");
const runtimeModules = process.env.GITRADER_POSTER_RUNTIME_MODULES
  ?? path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules");
const require = createRequire(path.join(runtimeModules, "_series-verifier.cjs"));
const sharp = require("sharp");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toLowerCase();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const lowerHash = (value) => String(value ?? "").toLowerCase();

const BASELINES = {
  "brand": [path.join(repoRoot, "assets", "brand"), 4, "3813a3ee758080fe5656fba0d196f451e96e29261e35e4f8b9abef9146017e9e"],
  "poster-v1": [path.join(repoRoot, "assets", "marketing", "poster-v1"), 13, "344f5ece1b6adc3d94ade3032584b2e583cd6b254389dccbc6899b9a58829bf8"],
  "poster-v2": [path.join(repoRoot, "assets", "marketing", "poster-v2"), 11, "f9b5823e121c58043152443fe3d1cc0aab8af28e34cbe9af510e6b1be26a0c14"],
  "poster-v3": [path.join(repoRoot, "assets", "marketing", "poster-v3"), 10, "0795122837e4b41f4eb81b42a2adcf1e2bd8746a3423bb2f1683eaa3e0a56195"],
};

function attrs(source) {
  const out = Object.fromEntries([...source.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((m) => [m[1], m[3]]));
  if (out.style) for (const declaration of out.style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
  }
  return out;
}

function decodeXml(text) {
  return text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replace(/&#(x?[0-9a-f]+);/gi, (_, raw) => String.fromCodePoint(Number.parseInt(raw.replace(/^x/i, ""), /^x/i.test(raw) ? 16 : 10)));
}

function textNodes(svg) {
  const stack = [];
  const nodes = [];
  let current = null;
  for (const match of svg.matchAll(/<\/?[\w:.-]+\b[^>]*>|[^<]+/g)) {
    const token = match[0];
    if (!token.startsWith("<")) { if (current) current.text += token; continue; }
    if (token.startsWith("</")) {
      const tag = token.match(/^<\/([\w:.-]+)/)?.[1]?.split(":").pop();
      if (tag === "text" && current) { current.text = decodeXml(current.text); nodes.push(current); current = null; }
      for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const rawTag = token.match(/^<([\w:.-]+)/)?.[1];
    if (!rawTag || token.startsWith("<?") || token.startsWith("<!")) continue;
    const tag = rawTag.split(":").pop();
    const own = attrs(token);
    const effective = Object.assign({}, ...stack.map((item) => item.attrs), own);
    if (tag === "text") current = { attrs: own, effective, text: "" };
    if (!token.endsWith("/>") && tag !== "text") stack.push({ tag, attrs: own });
  }
  return nodes;
}

function imageNodes(svg) {
  return [...svg.matchAll(/<image\b[\s\S]*?\/?\s*>/g)].map((match) => attrs(match[0]));
}

function dataPayload(image, mime) {
  const refs = [image.href, image["xlink:href"]].filter(Boolean);
  assert(refs.length > 0 && refs.every((ref) => ref === refs[0]), `${mime} href/xlink mismatch`);
  const prefix = `data:${mime};base64,`;
  assert(refs[0].startsWith(prefix), `${mime} is not an embedded data URI`);
  return Buffer.from(refs[0].slice(prefix.length), "base64");
}

function numberEqual(actual, expected) {
  return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - Number(expected)) < 1e-9;
}

async function treeHash(directory) {
  const names = (await fs.readdir(directory, { withFileTypes: true })).filter((item) => item.isFile()).map((item) => item.name).sort();
  const hash = crypto.createHash("sha256");
  for (const name of names) { hash.update(name.replaceAll("\\", "/")); hash.update(Buffer.from([0])); hash.update(await fs.readFile(path.join(directory, name))); }
  return { files: names.length, sha256: hash.digest("hex") };
}

async function assertBaselines() {
  for (const [label, [directory, expectedFiles, expectedHash]] of Object.entries(BASELINES)) {
    const actual = await treeHash(directory);
    assert(actual.files === expectedFiles, `${label} file count expected=${expectedFiles} actual=${actual.files}`);
    assert(actual.sha256 === expectedHash, `${label} baseline hash expected=${expectedHash} actual=${actual.sha256}`);
  }
}

function expectedTexts(layout, poster) {
  const { slots, colors, font } = layout;
  const make = (text, slot, x, y, letterSpacing = 0) => ({ text, x, y, fontSize: slot.fontSize, fontWeight: slot.fontWeight, fill: colors[slot.fillToken], letterSpacing, family: font.family });
  return [
    make(poster.eyebrow, slots.eyebrow, slots.eyebrow.x, slots.eyebrow.y, slots.eyebrow.letterSpacing),
    ...poster.title.map((text, i) => make(text, slots.title, slots.title.x, slots.title.ys[i])),
    ...poster.support.map((text, i) => make(text, slots.support, slots.support.x, slots.support.ys[i])),
    make(poster.sceneLabel, slots.sceneLabel, slots.sceneLabel.x, slots.sceneLabel.y),
    make(poster.shortTag, slots.shortTag, slots.shortTag.x, slots.shortTag.y),
    ...poster.benefits.map((text, i) => make(text, slots.benefits, slots.benefits.xs[i], slots.benefits.y)),
    make(poster.cta, slots.cta, slots.cta.x, slots.cta.y),
    make(layout.footer, slots.footer, slots.footer.x, slots.footer.y),
  ];
}

function assertTextContract(svg, layout, poster) {
  const actual = textNodes(svg);
  const expected = expectedTexts(layout, poster);
  assert(actual.length === 12, `${poster.id} text count expected=12 actual=${actual.length}`);
  for (const item of expected) {
    const matches = actual.filter((node) => node.text === item.text);
    assert(matches.length === 1, `${poster.id} text ${JSON.stringify(item.text)} expected once actual=${matches.length}`);
    const a = matches[0].effective;
    for (const key of ["x", "y", "font-size", "font-weight"]) {
      const expectedValue = { x: item.x, y: item.y, "font-size": item.fontSize, "font-weight": item.fontWeight }[key];
      assert(numberEqual(a[key], expectedValue), `${poster.id} ${item.text} ${key} expected=${expectedValue} actual=${a[key]}`);
    }
    assert(String(a.fill).toUpperCase() === item.fill.toUpperCase(), `${poster.id} ${item.text} fill expected=${item.fill} actual=${a.fill}`);
    assert(a["font-family"] === item.family, `${poster.id} ${item.text} font-family expected=${item.family} actual=${a["font-family"]}`);
    assert(numberEqual(a["letter-spacing"] ?? 0, item.letterSpacing), `${poster.id} ${item.text} letter-spacing expected=${item.letterSpacing} actual=${a["letter-spacing"] ?? 0}`);
  }
  return actual;
}

function assertManifestCopy(manifest, layout, poster) {
  if (manifest.copy) {
    const copy = manifest.copy;
    assert(JSON.stringify(copy.headline ?? copy.title) === JSON.stringify(poster.title), `${poster.id} manifest title differs`);
    for (const key of ["eyebrow", "support", "sceneLabel", "shortTag", "benefits", "cta"]) assert(JSON.stringify(copy[key]) === JSON.stringify(poster[key]), `${poster.id} manifest copy.${key} differs`);
    assert(copy.footer === layout.footer, `${poster.id} manifest footer differs`);
    return;
  }
  const meta = manifest.poster ?? {};
  assert(meta.id === poster.id && meta.directory === poster.directory, `${poster.id} manifest poster identity differs`);
  assert(JSON.stringify(meta.title) === JSON.stringify(poster.title) && Number(meta.textNodes) === 12, `${poster.id} manifest poster title/text count differs`);
  assert(Number(meta.canvas?.width) === layout.canvas.width && Number(meta.canvas?.height) === layout.canvas.height, `${poster.id} manifest canvas differs`);
  assert(Number(meta.preview?.width) === layout.preview.width && Number(meta.preview?.height) === layout.preview.height, `${poster.id} manifest preview differs`);
}

function evidenceObject(item) {
  if (typeof item !== "string") return item;
  return Object.fromEntries([...item.matchAll(/(?:^|[;{])\s*([\w-]+)=([^;}]+)/g)].map((match) => [match[1], match[2].trim()]));
}

function assertTypography(manifest, expectedFontHashes, id) {
  const typography = manifest.typography ?? {};
  const declaredFamily = typography.family ?? manifest.contract?.labelStyle?.family;
  assert(declaredFamily === "Microsoft YaHei" && typography.isolatedFontconfig === true, `${id} isolated font declaration differs`);
  const files = (typography.fontFiles ?? typography.localFontCopies ?? typography.isolatedFontFiles)?.map(evidenceObject);
  assert(Array.isArray(files) && files.length === 2, `${id} font file evidence expected=2 actual=${files?.length}`);
  for (const item of files) assert(expectedFontHashes[item.file] === lowerHash(item.sha256), `${id} font hash differs: ${item.file}`);
  const faces = (typography.renderEvidence ?? typography.posterRenderEvidence?.matchedFaces)?.map(evidenceObject);
  assert(Array.isArray(faces) && faces.length === 2 && faces.every((face) => ![false, "False", "false"].includes(face.loaded)), `${id} loaded font evidence differs`);
  assert(/weight:\s*80\b/.test(faces.find((face) => face.file === "msyh.ttc")?.weight ?? ""), `${id} Regular weight evidence differs`);
  assert(/weight:\s*200\b/.test(faces.find((face) => face.file === "msyhbd.ttc")?.weight ?? ""), `${id} Bold weight evidence differs`);
}

async function verifyPoster(layout, poster, logoBytes, expectedFontHashes) {
  const dir = path.join(here, poster.directory);
  const required = ["scene.png", "poster.svg", "poster.png", "poster-preview.png", "MANIFEST.json"];
  const fileBytes = Object.fromEntries(await Promise.all(required.map(async (name) => [name, await fs.readFile(path.join(dir, name))])));
  const svg = fileBytes["poster.svg"].toString("utf8");
  const manifest = JSON.parse(fileBytes["MANIFEST.json"].toString("utf8"));
  const root = attrs(svg.match(/<svg\b[^>]*>/)?.[0] ?? "");
  assert(numberEqual(root.width, layout.canvas.width) && numberEqual(root.height, layout.canvas.height) && root.viewBox === `0 0 ${layout.canvas.width} ${layout.canvas.height}`, `${poster.id} SVG canvas differs`);
  assert(!/<(?:script|foreignObject)\b/i.test(svg), `${poster.id} forbidden active/external SVG element`);
  const images = imageNodes(svg);
  assert(images.length === 2, `${poster.id} image count expected=2 actual=${images.length}`);
  const sceneImage = images.find((image) => (image.href ?? image["xlink:href"] ?? "").startsWith("data:image/png;base64,"));
  const logoImage = images.find((image) => (image.href ?? image["xlink:href"] ?? "").startsWith("data:image/svg+xml;base64,"));
  assert(sceneImage && logoImage, `${poster.id} embedded scene/logo image missing`);
  const sceneBytes = dataPayload(sceneImage, "image/png");
  const embeddedLogo = dataPayload(logoImage, "image/svg+xml");
  assert(sceneBytes.equals(fileBytes["scene.png"]), `${poster.id} embedded scene bytes differ from scene.png`);
  assert(embeddedLogo.equals(logoBytes), `${poster.id} embedded logo bytes differ from approved brand source`);
  for (const [key, value] of Object.entries(layout.sourceScene)) if (["x", "y", "width", "height", "opacity"].includes(key)) assert(numberEqual(sceneImage[key] ?? (key === "opacity" ? 1 : undefined), value), `${poster.id} scene ${key} expected=${value} actual=${sceneImage[key]}`);
  for (const key of ["x", "y", "width", "height"]) assert(numberEqual(logoImage[key], layout.brand[key]), `${poster.id} logo ${key} expected=${layout.brand[key]} actual=${logoImage[key]}`);
  assertTextContract(svg, layout, poster);
  assertManifestCopy(manifest, layout, poster);
  const [sceneMeta, posterMeta, previewMeta] = await Promise.all([sharp(fileBytes["scene.png"]).metadata(), sharp(fileBytes["poster.png"]).metadata(), sharp(fileBytes["poster-preview.png"]).metadata()]);
  assert(sceneMeta.width * 3 === sceneMeta.height * 2, `${poster.id} source scene ratio expected=2:3 actual=${sceneMeta.width}:${sceneMeta.height}`);
  assert(posterMeta.width === layout.canvas.width && posterMeta.height === layout.canvas.height, `${poster.id} poster PNG dimensions expected=2048x3072 actual=${posterMeta.width}x${posterMeta.height}`);
  assert(previewMeta.width === layout.preview.width && previewMeta.height === layout.preview.height, `${poster.id} preview dimensions expected=1024x1536 actual=${previewMeta.width}x${previewMeta.height}`);
  const sceneHash = sha256(fileBytes["scene.png"]), logoHash = sha256(logoBytes);
  const manifestScene = manifest.sourceScene ?? manifest.scene ?? manifest.sources?.scene ?? {};
  assert(lowerHash(manifestScene.sha256) === sceneHash, `${poster.id} manifest scene hash differs`);
  assert(Number(manifestScene.width ?? manifestScene.sourceWidth) === sceneMeta.width && Number(manifestScene.height ?? manifestScene.sourceHeight) === sceneMeta.height, `${poster.id} manifest scene dimensions are not actual source dimensions`);
  assert(lowerHash(manifest.brand?.sha256 ?? manifest.sources?.logo?.sha256) === logoHash, `${poster.id} manifest logo hash differs`);
  for (const name of ["poster.svg", "poster.png", "poster-preview.png"]) assert(lowerHash(manifest.outputs?.[name]?.sha256) === sha256(fileBytes[name]), `${poster.id} manifest output hash differs: ${name}`);
  assertTypography(manifest, expectedFontHashes, poster.id);
  const visible = textNodes(svg).map((node) => node.text).join(" ");
  const forbidden = ["保证收益", "保本", "自动赚钱", "全部上链", "全流程上链", "已正式上线", "实盘已验证", "收益率", "平台提供策略", "平台提供数据", "跑分", "GPU"];
  assert(!forbidden.some((term) => visible.includes(term)), `${poster.id} forbidden/absolute claim present`);
  return {
    id: poster.id, directory: poster.directory, scene: { sha256: sceneHash, width: sceneMeta.width, height: sceneMeta.height, hasAlpha: sceneMeta.hasAlpha },
    output: { svg: sha256(fileBytes["poster.svg"]), png: sha256(fileBytes["poster.png"]), preview: sha256(fileBytes["poster-preview.png"]) }, textNodes: 12,
  };
}

async function assertReadmeLinks(readmePath) {
  const markdown = await fs.readFile(readmePath, "utf8");
  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert(links.length >= 20, `README relative link count unexpectedly low: ${links.length}`);
  for (const link of links) {
    assert(!/^[a-z]+:/i.test(link) && !path.isAbsolute(link), `README link must be relative: ${link}`);
    const target = path.resolve(path.dirname(readmePath), decodeURIComponent(link.split("#")[0]));
    assert(target.startsWith(path.resolve(here)), `README link escapes series directory: ${link}`);
    await fs.access(target);
  }
  return links.length;
}

async function verifyOverview(layout, posterResults, expectedFontHashes) {
  const [overviewBytes, manifestBytes, renderer, readmeLinks] = await Promise.all([
    fs.readFile(path.join(here, "overview.png")), fs.readFile(path.join(here, "MANIFEST.json")),
    fs.readFile(path.join(here, "render-overview.mjs"), "utf8"), assertReadmeLinks(path.join(here, "README.md")),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const meta = await sharp(overviewBytes).metadata();
  const contract = layout.overview;
  assert(meta.width === contract.width && meta.height === contract.height, `overview dimensions expected=${contract.width}x${contract.height} actual=${meta.width}x${meta.height}`);
  assert(lowerHash(manifest.output?.sha256) === sha256(overviewBytes) && Number(manifest.output?.width) === meta.width && Number(manifest.output?.height) === meta.height, "overview manifest output hash/dimensions differ");
  const expectedDirs = layout.posters.map((poster) => poster.directory), expectedLabels = layout.posters.map((poster) => poster.overviewLabel);
  assert(JSON.stringify(manifest.contract?.order) === JSON.stringify(expectedDirs), "overview manifest poster order differs");
  assert(JSON.stringify(manifest.contract?.labels) === JSON.stringify(expectedLabels), "overview manifest labels differ");
  const actualContract = manifest.contract?.canvas ?? {};
  for (const key of ["width", "height", "columns", "rows", "thumbnailWidth", "thumbnailHeight", "labelFontSize", "labelFontWeight"]) assert(Number(actualContract[key]) === Number(contract[key]), `overview manifest contract.${key} differs`);
  for (const key of ["xs", "ys", "labelYs", "order"]) assert(JSON.stringify(actualContract[key]) === JSON.stringify(contract[key]), `overview manifest contract.${key} differs`);
  assertTypography(manifest, expectedFontHashes, "overview");
  assert(/<reset-dirs\s*\/>/.test(renderer) && renderer.includes("FONTCONFIG_FILE") && renderer.includes("Microsoft YaHei"), "overview renderer isolation logic missing");
  for (const label of expectedLabels) assert(renderer.includes(label), `overview renderer label missing: ${label}`);
  assert(manifest.posters?.length === 6, `overview manifest poster count expected=6 actual=${manifest.posters?.length}`);
  for (let i = 0; i < layout.posters.length; i += 1) {
    const poster = layout.posters[i], record = manifest.posters[i];
    assert(record.id === poster.id && record.directory === poster.directory && record.label === poster.overviewLabel, `overview manifest item ${poster.id} identity/order differs`);
    for (const [kind, filename] of [["poster", "poster.png"], ["preview", "poster-preview.png"]]) {
      const bytes = await fs.readFile(path.join(here, poster.directory, filename));
      assert(record[kind]?.file === `${poster.directory}/${filename}` && lowerHash(record[kind]?.sha256) === sha256(bytes), `overview manifest ${poster.id} ${kind} hash/path differs`);
    }
    const x = contract.xs[i % contract.columns], y = contract.ys[Math.floor(i / contract.columns)];
    const [actualThumb, expectedThumb] = await Promise.all([
      sharp(overviewBytes).extract({ left: x, top: y, width: contract.thumbnailWidth, height: contract.thumbnailHeight }).removeAlpha().raw().toBuffer(),
      sharp(path.join(here, poster.directory, "poster.png")).resize(contract.thumbnailWidth, contract.thumbnailHeight, { fit: "fill", kernel: "lanczos3" }).removeAlpha().raw().toBuffer(),
    ]);
    assert(actualThumb.equals(expectedThumb), `overview thumbnail pixels differ from resized source poster: ${poster.id}`);
  }
  assert(new Set(posterResults.map((item) => item.scene.sha256)).size === 6, "overview series source scenes are not all distinct");
  return { sha256: sha256(overviewBytes), width: meta.width, height: meta.height, order: layout.overview.order, readmeRelativeLinks: readmeLinks, thumbnailsPixelEqual: true };
}

async function run() {
  const layout = JSON.parse(await fs.readFile(path.join(here, "layout.json"), "utf8"));
  const requested = process.argv.slice(2).map((value) => value.padStart(2, "0"));
  const ids = requested.length ? requested : layout.posters.map((poster) => poster.id);
  assert(new Set(ids).size === ids.length, "poster IDs must be unique");
  const selected = ids.map((id) => layout.posters.find((poster) => poster.id === id));
  assert(selected.every(Boolean), `unknown poster ID; expected one of ${layout.posters.map((poster) => poster.id).join(",")}`);
  await assertBaselines();
  const [logoBytes, regularBytes, boldBytes] = await Promise.all([fs.readFile(path.resolve(here, layout.brand.source)), fs.readFile("C:/Windows/Fonts/msyh.ttc"), fs.readFile("C:/Windows/Fonts/msyhbd.ttc")]);
  const expectedFontHashes = { "msyh.ttc": sha256(regularBytes), "msyhbd.ttc": sha256(boldBytes) };
  const results = [];
  for (const poster of selected) results.push(await verifyPoster(layout, poster, logoBytes, expectedFontHashes));
  assert(new Set(results.map((item) => item.scene.sha256)).size === results.length, `selected source scenes are not all distinct`);
  const allSelected = ids.length === layout.posters.length && layout.posters.every((poster) => ids.includes(poster.id));
  const overview = allSelected ? await verifyOverview(layout, results, expectedFontHashes) : null;
  const result = { status: "AUTOMATED_PASS_AWAITING_VISUAL", selected: ids, baselineTrees: Object.fromEntries(Object.entries(BASELINES).map(([label, value]) => [label, value[2]])), logoSha256: sha256(logoBytes), posters: results, overview, limitations: ["domain readability, scene distinctness, occlusion, garbling, CTA/footer legibility, and poster 03 physical-product implication require independent visual inspection"] };
  const lines = results.map((item) => `- ${item.id}: scene ${item.scene.width}×${item.scene.height} \`${item.scene.sha256}\`; PNG \`${item.output.png}\``).join("\n");
  const overviewLine = overview ? `\n- 总览：${overview.width}×${overview.height} \`${overview.sha256}\`；6 个缩图逐像素等于源主图按合同缩放，README ${overview.readmeRelativeLinks} 个相对链接有效。` : "";
  await fs.writeFile(path.join(here, "VERIFICATION.md"), `# Series V1 独立验收\n\n**自动门禁通过，待目视裁决**。子集：${ids.join(", ")}。品牌与 poster-v1/v2/v3 施工前目录聚合 SHA 均未变；每张 12 个原生文字节点，文案/位置/字号/字重/色值、scene/logo 原字节内嵌、实际源尺寸、2048×3072 主图、1024×1536 预览、manifest 哈希及隔离字体证据通过。\n\n${lines}${overviewLine}\n\n未运行 renderer、产品测试、提交或发布。\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

try { await run(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", error: `${error.name}: ${error.message}` })); process.exitCode = 1; }
