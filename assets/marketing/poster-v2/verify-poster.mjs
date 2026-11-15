import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Codex 运行时目录由本机 home 推导（可用 GITRADER_POSTER_RUNTIME_MODULES 覆盖），不写死绝对路径。
const runtimeModules = process.env.GITRADER_POSTER_RUNTIME_MODULES
  ?? path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules");
const require = createRequire(path.join(runtimeModules, "_poster-v2-verifier.cjs"));
const sharp = require("sharp");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toLowerCase();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const attrs = (source) => Object.fromEntries([...source.matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)].map((match) => [match[1], match[2]]));
const decodeXml = (text) => text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");

const V1_BASELINE = {
  "BLUEPRINT.md": "7cbe9294361cfe33df054ee56abff7bc28a7a20e440b2cbd91f301ee8be154d0",
  "hero-v1.png": "547f0de54c7256d9dd5eab756779f7848d520ac9bfa7c7acc6595f819e440c31",
  "hero-v2-alpha.png": "e0a4ca7ebe67d6d4f1f30dbfba5f9935f24b943fc6f1a5eb978fbb4915394962",
  "MANIFEST.json": "12f6f67482a4181a23026d6812c12364ce0ec8ddd49b881ffe2eaeb915ad47ba",
  "poster-preview.png": "e32da2a6bb191d8d850c0dba9aea98a3b81783ddc5b5fda81b18eb135d603c71",
  "poster.png": "dd81ef2ad20a46f25219caf2cdcbcc097edd7f5857136110bf8017931f9c3bb6",
  "poster.svg": "03f1cb2bbfa846d2377c031311f8fa51a109959ce2813a665d1b1ce28c8fd49f",
  "PROMPT-alpha.md": "b66ad157e4f188448c4f175373143e7fb6e2c6983b9aa75df932ab7379a6d4b3",
  "PROMPT.md": "725d7a33782d6ae14a61a473a8040ab1f6cf0d7141917b51c45cac67961782c4",
  "README.md": "b3b52cf9b8cce895055c3e6376edd3baba5709e732ce054d0dbf3d8dc88a9733",
  "render-poster.mjs": "3ef7283a8cc6996d330dee16fa9cf987110a9f6500042fa8ae8f87e31fe346b2",
  "VERIFICATION.md": "1af989a194674579a01e8e086370424269460b36327881610b205558220e46e6",
  "verify-poster.mjs": "fe7bcd4e799e86022be14ba142167225f31214c7aa412a631349dadd8cdc20fa",
};
const BRAND_BASELINE = {
  "gitrader-wordmark.png": "5bf1a20520203f8ed4da3d54a49fd8b5043379b272f661ebf2c6ab5fb31fbf01",
  "gitrader-wordmark.svg": "7bd5526f8c439c17bca10a8c37193a6b231884ea0cbdacef05cc2e9a511a1b05",
  "README.md": "0cbd3e45d18d905ca1f75453d86b26dc68770190e7656df4ef867b3aad4f9718",
  "SHA256SUMS": "560fa1c1c29c7fb6fd3374f1ed442fa9bfa8bdb9de995f64ce30407f72de241f",
};
const TEXTS = [
  ["AGENT TRADING INFRASTRUCTURE",160,310,26,400,"#A9A6A0",2], ["AI 交易的",160,502,176,700,"#F6F3EC",0],
  ["可组合底座",160,706,176,700,"#F6F3EC",0], ["接入你自己的智能体、策略引擎与交易场所。",164,842,44,400,"#A9A6A0",0],
  ["策略与数据由你掌握，执行权限由你设定。",164,916,44,400,"#A9A6A0",0], ["K 线行情 · 订单簿",160,1080,30,400,"#A9A6A0",0],
  ["交易界面概念示意 · 非实时行情",160,2148,26,400,"#A9A6A0",0], ["自由接入",160,2320,50,700,"#F6F3EC",0],
  ["通过 MCP 接入智能体，连接任意语言引擎。",656,2320,38,400,"#A9A6A0",0], ["四档权限",160,2480,50,700,"#F6F3EC",0],
  ["只读、纸面、需确认、限额自动，按需授权。",656,2480,38,400,"#A9A6A0",0], ["操作留痕",160,2640,50,700,"#F6F3EC",0],
  ["记录来源、动作与风控判断，支持导出与核验。",656,2640,38,400,"#A9A6A0",0], ["开源底座 · M1 开发中",160,2840,30,400,"#A9A6A0",0],
  ["策略与数据自有 · 资金不托管",160,2920,28,400,"#A9A6A0",0], ["自有 Agent",184,1192,34,700,"#F6F3EC",0],
  ["MCP 接入",184,1238,26,400,"#A9A6A0",0], ["自有策略",1584,1972,34,700,"#F6F3EC",0],
  ["连接自有引擎",1584,2018,26,400,"#A9A6A0",0],
].map(([text,x,y,size,weight,fill,spacing]) => ({ text, x:String(x), y:String(y), size:String(size), weight:String(weight), fill, spacing:String(spacing) }));

function collectTexts(svg) {
  const result = [];
  const groups = [...svg.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/g)];
  for (const group of groups) {
    const inherited = attrs(group[1]);
    for (const match of group[2].matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) result.push({ ...inherited, ...attrs(match[1]), text: decodeXml(match[2]) });
  }
  const outside = svg.replace(/<g\b[^>]*>[\s\S]*?<\/g>/g, "");
  for (const match of outside.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) result.push({ ...attrs(match[1]), text: decodeXml(match[2]) });
  return result;
}
function decodeData(tag, mime) {
  const refs = [...tag.matchAll(/(?:href|xlink:href)="([^"]+)"/g)].map((match) => match[1]);
  assert(refs.length && refs.every((ref) => ref === refs[0]), `${mime} href mismatch`);
  const prefix = `data:${mime};base64,`;
  assert(refs[0].startsWith(prefix), `${mime} not base64 data URI`);
  return Buffer.from(refs[0].slice(prefix.length), "base64");
}
async function assertBaselines(directory, baseline, label) {
  const actualNames = (await fs.readdir(directory, { withFileTypes:true })).filter((item) => item.isFile()).map((item) => item.name).sort();
  assert(JSON.stringify(actualNames) === JSON.stringify(Object.keys(baseline).sort()), `${label} file set changed`);
  for (const [name, expected] of Object.entries(baseline)) assert(sha256(await fs.readFile(path.join(directory,name))) === expected, `${label}/${name} changed`);
}
function offset(value) { return value.endsWith("%") ? Number(value.slice(0,-1))/100 : Number(value); }

async function run() {
  const v1 = path.resolve(here, "../poster-v1");
  const brand = path.resolve(here, "../../brand");
  await assertBaselines(v1, V1_BASELINE, "poster-v1");
  await assertBaselines(brand, BRAND_BASELINE, "brand");
  const paths = { svg:path.join(here,"poster.svg"), png:path.join(here,"poster.png"), preview:path.join(here,"poster-preview.png"), scene:path.join(here,"scene-v2.png"), manifest:path.join(here,"MANIFEST.json"), renderer:path.join(here,"render-poster.mjs"), report:path.join(here,"VERIFICATION.md") };
  const [svgBytes,pngBytes,previewBytes,sceneBytes,manifestBytes,renderer,logoBytes,font400,font700] = await Promise.all([
    fs.readFile(paths.svg),fs.readFile(paths.png),fs.readFile(paths.preview),fs.readFile(paths.scene),fs.readFile(paths.manifest),fs.readFile(paths.renderer,"utf8"),fs.readFile(path.join(brand,"gitrader-wordmark.svg")),fs.readFile("C:/Windows/Fonts/msyh.ttc"),fs.readFile("C:/Windows/Fonts/msyhbd.ttc")
  ]);
  const svg=svgBytes.toString("utf8"), manifest=JSON.parse(manifestBytes.toString("utf8"));
  const root=attrs(svg.match(/<svg\b([^>]*)>/)?.[1] ?? "");
  assert(root.width==="2048" && root.height==="3072" && root.viewBox==="0 0 2048 3072", "SVG canvas differs");
  const allRectTags=[...svg.matchAll(/<rect\b[^>]*\/>/g)].map((match)=>match[0]);
  const backgroundTag=allRectTags.find((tag)=>{const a=attrs(tag);return (a.x??"0")==="0"&&(a.y??"0")==="0"&&a.width==="2048"&&a.height==="3072"&&a.fill==="#0A0A0B";});
  assert(backgroundTag,"background differs");
  const imageTags=[...svg.matchAll(/<image\b[^>]*\/>/g)].map((match)=>match[0]);
  assert(imageTags.length===2,`image count expected=2 actual=${imageTags.length}`);
  const logoTag=imageTags.find((tag)=>tag.includes("data:image/svg+xml;base64,"));
  const sceneTag=imageTags.find((tag)=>tag.includes("data:image/png;base64,"));
  assert(logoTag && sceneTag,"logo/scene image missing");
  const la=attrs(logoTag), sa=attrs(sceneTag);
  assert(JSON.stringify([la.x,la.y,la.width,la.height,la.preserveAspectRatio])===JSON.stringify(["153.2","133.2","355.961765722","81.6","xMidYMid meet"]),"logo placement differs");
  assert(JSON.stringify([sa.x,sa.y,sa.width,sa.height,sa.preserveAspectRatio])===JSON.stringify(["0","0","2048","3072","xMidYMid meet"]),"scene placement differs");
  assert(decodeData(logoTag,"image/svg+xml").equals(logoBytes),"embedded logo bytes differ");
  assert(decodeData(sceneTag,"image/png").equals(sceneBytes),"embedded scene bytes differ");

  const gradientMatch=svg.match(/<linearGradient\b([^>]*)>([\s\S]*?)<\/linearGradient>/);
  assert(gradientMatch,"shade gradient missing");
  const ga=attrs(gradientMatch[1]);
  assert(ga.gradientUnits==="userSpaceOnUse" && ga.x1==="0" && ga.x2==="0" && ga.y1==="0" && ga.y2==="3072","gradient axis differs");
  const stops=[...gradientMatch[2].matchAll(/<stop\b([^>]*)\/>/g)].map((m)=>attrs(m[1]));
  const expectedOffsets=[0,960/3072,1104/3072,2048/3072,2240/3072,1], expectedOpacity=[1,1,0,0,1,1];
  assert(stops.length===6,"gradient stop count differs");
  stops.forEach((stop,index)=>{assert(Math.abs(offset(stop.offset)-expectedOffsets[index])<1e-6 && Math.abs(Number(stop["stop-opacity"])-expectedOpacity[index])<1e-9,"gradient stop differs");assert(stop["stop-color"]==="#0A0A0B","gradient color differs");});
  const overlay=allRectTags.find((tag)=>{const a=attrs(tag);return (a.x??"0")==="0"&&(a.y??"0")==="0"&&a.width==="2048"&&a.height==="3072"&&a.fill===`url(#${ga.id})`;});
  assert(overlay && svg.indexOf(sceneTag)<svg.indexOf(overlay) && svg.indexOf(overlay)<svg.indexOf(logoTag),"layer order differs");

  const actualTexts=collectTexts(svg);
  assert(actualTexts.length===TEXTS.length,`text count expected=${TEXTS.length} actual=${actualTexts.length}`);
  for(const expected of TEXTS){const actual=actualTexts.find((item)=>item.text===expected.text);assert(actual,`missing text: ${expected.text}`);const got=[actual.x,actual.y,actual["font-size"],actual["font-weight"],actual.fill,actual["letter-spacing"]??"0",actual["font-family"]];const want=[expected.x,expected.y,expected.size,expected.weight,expected.fill,expected.spacing,"Microsoft YaHei"];assert(JSON.stringify(got)===JSON.stringify(want),`text attributes differ: ${expected.text}`);assert(!("textLength" in actual),`textLength forbidden: ${expected.text}`);}
  const cardRects=[...svg.matchAll(/<rect\b([^>]*)\/>/g)].map((m)=>attrs(m[1])).filter((a)=>a.x==="160"&&a.y==="1140" || a.x==="1560"&&a.y==="1920");
  assert(cardRects.length===2,"integration card count differs");
  const cardExpected=[["160","1140","320","140"],["1560","1920","328","140"]];
  cardRects.forEach((a,i)=>{assert(JSON.stringify([a.x,a.y,a.width,a.height])===JSON.stringify(cardExpected[i]),"card geometry differs");assert(a.rx==="16"&&a.fill==="#141414"&&Number(a["fill-opacity"])===0.94&&a.stroke==="#F6F3EC"&&Number(a["stroke-opacity"])===0.14&&Number(a["stroke-width"])===1.5,"card style differs");});
  const dividerGroup=[...svg.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/g)].find((match)=>{const a=attrs(match[1]);return a.fill==="none"&&a.stroke==="#292623"&&Number(a["stroke-width"])===1;});
  assert(dividerGroup,"divider group missing");
  const dividerPaths=[...dividerGroup[2].matchAll(/<path\b([^>]*)\/>/g)].map((match)=>attrs(match[1]).d);
  assert(JSON.stringify(dividerPaths)===JSON.stringify(["M160 2400H1888","M160 2560H1888"]),"divider geometry differs");
  const hrefs=[...svg.matchAll(/(?:href|xlink:href)="([^"]+)"/g)].map((m)=>m[1]);
  assert(hrefs.length===4&&hrefs.every((href)=>href.startsWith("data:")),"external href present");
  const visible=actualTexts.map((item)=>item.text).join(" ").replace("资金不托管","");
  const forbidden=["保证收益","收益率","客户案例","真实行情","全面上线","交易所","官方合作","提供策略","提供数据","行情供给","托管资金"];
  assert(!forbidden.some((term)=>visible.includes(term)),"forbidden claim present");

  const [posterMeta,previewMeta,sceneMeta,sceneStats]=await Promise.all([sharp(pngBytes).metadata(),sharp(previewBytes).metadata(),sharp(sceneBytes).metadata(),sharp(sceneBytes).stats()]);
  assert(posterMeta.width===2048&&posterMeta.height===3072,"poster dimensions differ");
  assert(previewMeta.width===1024&&previewMeta.height===1536,"preview dimensions differ");
  assert(sceneMeta.width/sceneMeta.height===2/3 && sceneMeta.width>=1024 && sceneMeta.height>=1536,"scene dimensions/aspect differ");
  if(sceneMeta.hasAlpha) assert(sceneStats.channels[3].min===255,"scene must be opaque");
  const hashes={svg:sha256(svgBytes),png:sha256(pngBytes),preview:sha256(previewBytes),scene:sha256(sceneBytes),logo:sha256(logoBytes)};
  const sceneManifest=manifest.sources?.scene??manifest.sources?.hero;
  assert(manifest.composition?.scene?.file==="scene-v2.png"&&sceneManifest?.sha256.toLowerCase()===hashes.scene,"manifest scene differs");
  assert(manifest.sources?.logo?.sha256.toLowerCase()===hashes.logo,"manifest logo differs");
  for(const [name,key] of [["poster.svg","svg"],["poster.png","png"],["poster-preview.png","preview"]])assert(manifest.outputs?.[name]?.sha256.toLowerCase()===hashes[key],`manifest hash differs: ${name}`);
  const typo=manifest.typography;
  assert(typo?.family==="Microsoft YaHei"&&typo.isolatedFontconfig===true&&typo.regularWeight===400&&typo.boldWeight===700,"typography manifest differs");
  const fonts={"msyh.ttc":sha256(font400),"msyhbd.ttc":sha256(font700)};
  const isolatedFonts=typo.isolatedFontFiles??typo.localFontCopies;
  assert(Array.isArray(isolatedFonts)&&isolatedFonts.length===2,"isolated font list differs");
  isolatedFonts.forEach((item)=>assert(fonts[item.file]===item.sha256.toLowerCase(),`font hash differs: ${item.file}`));
  const evidenceSets=typo.renderEvidence ? [["renderEvidence",typo.renderEvidence]] : [["isolatedSampleEvidence",typo.isolatedSampleEvidence?.matchedFaces],["posterRenderEvidence",typo.posterRenderEvidence?.matchedFaces]];
  for(const [name,faces] of evidenceSets){assert(Array.isArray(faces)&&faces.length===2,`${name} incomplete`);const regular=faces.find((f)=>f.file==="msyh.ttc"),bold=faces.find((f)=>f.file==="msyhbd.ttc");assert(regular&&bold&&regular.loaded!==false&&bold.loaded!==false&&/weight:\s*80\b/.test(regular.weight)&&/weight:\s*200\b/.test(bold.weight),`${name} weights/load differ`);}
  const childStart=Math.max(renderer.indexOf("async function rendererChild()"),renderer.indexOf("async function child()"));
  const rendererChecks={resetDirs:renderer.includes("<reset-dirs/>"),env:renderer.includes("FONTCONFIG_FILE: configPath")&&/FONTCONFIG_PATH:\s*(?:tempDir|root)/.test(renderer)&&renderer.includes('FC_DEBUG: "1060"'),isolatedSpawn:renderer.includes('[scriptPath, "--child", "--render"')||renderer.includes('[scriptPath, "--renderer-child"'),childSharp:childStart>=0&&renderer.indexOf('const sharp = require("sharp")')>childStart,scene:renderer.includes('scene-v2.png')};
  assert(Object.values(rendererChecks).every(Boolean),"renderer isolation/source logic differs");
  const visibleLogoPercent=355.961765722*(1026.946369771124-20)/1046.946369771124/2048*100;
  assert(/conceptual interface/i.test(manifest.note??"")&&/not a screenshot of a live exchange/i.test(manifest.note??""),"manifest concept disclaimer missing");
  const result={status:"AUTOMATED_PASS_AWAITING_VISUAL",sourceHashes:{scene:hashes.scene,logo:hashes.logo},outputHashes:{svg:hashes.svg,png:hashes.png,preview:hashes.preview},dimensions:{scene:[sceneMeta.width,sceneMeta.height],poster:[posterMeta.width,posterMeta.height],preview:[previewMeta.width,previewMeta.height]},textCount:actualTexts.length,cards:cardRects.length,visibleLogoPercent,fontEvidence:{files:isolatedFonts,evidenceSets:evidenceSets.map(([name,faces])=>({name,faces:faces.map((face)=>[face.file,face.weight])})),rendererChecks},v1Unchanged:true,brandUnchanged:true,limitations:["trading-vs-GPU reading, chart/order-book clarity, seams, flow overlap, and text collisions require visual inspection"]};
  await fs.writeFile(paths.report,`# Poster V2 独立验收\n\n**自动门禁通过，待目视裁决**。scene \`${hashes.scene}\`，logo \`${hashes.logo}\`，poster PNG \`${hashes.png}\`。V1/品牌、内嵌字节、画布、19条文案、两卡、渐变、manifest与字体证据通过。未运行renderer、提交或发布。\n`,"utf8");
  console.log(JSON.stringify(result,null,2));
}

try{await run();}catch(error){console.error(JSON.stringify({status:"FAIL",error:`${error.name}: ${error.message}`}));process.exitCode=1;}
