import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here=path.dirname(fileURLToPath(import.meta.url));
// Codex 运行时目录由本机 home 推导（可用 GITRADER_POSTER_RUNTIME_MODULES 覆盖），不写死绝对路径。
const runtimeModules=process.env.GITRADER_POSTER_RUNTIME_MODULES??path.join(os.homedir(),".cache","codex-runtimes","codex-primary-runtime","dependencies","node","node_modules");
const require=createRequire(path.join(runtimeModules,"_poster-v3-verifier.cjs"));
const sharp=require("sharp");
const sha256=(bytes)=>crypto.createHash("sha256").update(bytes).digest("hex").toLowerCase();
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const attrs=(source)=>Object.fromEntries([...source.matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)].map((m)=>[m[1],m[2]]));
const decodeXml=(text)=>text.replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;", "'");

const V2_BASELINE={
  "BLUEPRINT.md":"a5b42e05ac0e2f6be12967e4cc26e6ad89a3db9bbf37497ea03de792a09ac8a5","MANIFEST.json":"45ba3b098f95eef63cc3c1e9070ed5224bb26ccc2f92ea078b8b409b4a27fcd6",
  "poster-preview.png":"84fabb2a7b4ac024d1a60e3018abf11e5ab1feb567e26296723b446afe28fee3","poster.png":"b4db170ca752b67131e1070eb8f50e9eba174583d216b3b3320365fe23b9d577",
  "poster.svg":"9fc7d92ef955a441e47692584be0e31d21de44e070d9bdb33197df5ecb91b3ec","PROMPT.md":"f4e02842acd0f7fdb22ad2d9167f848e483545fc3c7508042f537578148ba7b8",
  "README.md":"1f5614de1ac3bbf2fd55e32d7149f2447a60acb646323a686e67b0348f354b72","render-poster.mjs":"2d0eb29d86d1ffdb172236acf642eb6631271fc6566616a133b716383e2d7a4c",
  "scene-v2.png":"026c26bb4d182d65f7a5c1acdc0db29f3d31cd609005da8ad3ade0e9b6f55727","VERIFICATION.md":"3087259c2c2df012fd1d24d4a3e52b3c4f6e0d00d46629fe51b2b4c7d5f3ef62",
  "verify-poster.mjs":"f40cf764d2efdedfed7e8bbbfafe5675f6def8517f60da2e1e1c5759747aed1f",
};
const BRAND_BASELINE={"gitrader-wordmark.png":"5bf1a20520203f8ed4da3d54a49fd8b5043379b272f661ebf2c6ab5fb31fbf01","gitrader-wordmark.svg":"7bd5526f8c439c17bca10a8c37193a6b231884ea0cbdacef05cc2e9a511a1b05","README.md":"0cbd3e45d18d905ca1f75453d86b26dc68770190e7656df4ef867b3aad4f9718","SHA256SUMS":"560fa1c1c29c7fb6fd3374f1ed442fa9bfa8bdb9de995f64ce30407f72de241f"};
const COPY=[
  ["AGENT TRADING INFRASTRUCTURE","YOUR AI. YOUR TRADING SYSTEM."],["AI 交易的","让你的 AI"],["可组合底座","拥有交易能力"],
  ["接入你自己的智能体、策略引擎与交易场所。","智能体、策略引擎、交易场所，按你的想法组合。"],["策略与数据由你掌握，执行权限由你设定。","策略由你选择，权限由你设定，行动有据可查。"],
  ["K 线行情 · 订单簿","K 线行情 · 订单簿"],["交易界面概念示意 · 非实时行情","交易界面概念示意 · 非实时行情"],["自由接入","自由组合"],
  ["通过 MCP 接入智能体，连接任意语言引擎。","用 MCP 接入你的 AI，连接自选引擎与场所。"],["四档权限","你来授权"],
  ["只读、纸面、需确认、限额自动，按需授权。","只读、纸面、需确认、限额自动，四档由你选。"],["操作留痕","看清行动"],
  ["记录来源、动作与风控判断，支持导出与核验。","谁在操作、为何执行、风控如何判断，清楚可查。"],["开源底座 · M1 开发中","开源底座 · M1 开发中"],
  ["策略与数据自有 · 资金不托管","策略与数据自有 · 资金不托管"],["自有 Agent","你的 AI"],["MCP 接入","由你接入"],["自有策略","你的策略"],["连接自有引擎","连接你的引擎"],
];

async function assertBaseline(directory,baseline,label){const names=(await fs.readdir(directory,{withFileTypes:true})).filter((item)=>item.isFile()).map((item)=>item.name).sort();assert(JSON.stringify(names)===JSON.stringify(Object.keys(baseline).sort()),`${label} file set changed`);for(const [name,hash] of Object.entries(baseline))assert(sha256(await fs.readFile(path.join(directory,name)))===hash,`${label}/${name} changed`);}
function textNodes(svg){return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match)=>({attrs:attrs(match[1]),text:decodeXml(match[2])}));}
function canonicalWithoutText(svg){return svg.replace(/^\s*<\?xml[^>]*\?>\s*/i,"").replace(/<!--([\s\S]*?)-->/g,"").replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/g,"").replace(/<svg\b([^>]*)>/,(_,raw)=>`<svg${raw.replace(/\s+version="[^"]*"/,"")}>`).replace(/(<text\b[^>]*>)[\s\S]*?(<\/text>)/g,"$1__TEXT__$2").replaceAll("\r\n","\n").trim();}
function imagePayload(svg,mime){const tag=[...svg.matchAll(/<image\b[^>]*\/>/g)].map((m)=>m[0]).find((value)=>value.includes(`data:${mime};base64,`));assert(tag,`${mime} image missing`);const refs=[...tag.matchAll(/(?:href|xlink:href)="([^"]+)"/g)].map((m)=>m[1]);assert(refs.length&&refs.every((ref)=>ref===refs[0]),`${mime} href mismatch`);return Buffer.from(refs[0].slice(`data:${mime};base64,`.length),"base64");}

async function run(){
  const v2=path.resolve(here,"../poster-v2"),brand=path.resolve(here,"../../brand");
  await assertBaseline(v2,V2_BASELINE,"poster-v2");await assertBaseline(brand,BRAND_BASELINE,"brand");
  const files={sourceSvg:path.join(v2,"poster.svg"),scene:path.join(v2,"scene-v2.png"),logo:path.join(brand,"gitrader-wordmark.svg"),svg:path.join(here,"poster.svg"),png:path.join(here,"poster.png"),preview:path.join(here,"poster-preview.png"),manifest:path.join(here,"MANIFEST.json"),report:path.join(here,"VERIFICATION.md")};
  const [sourceBytes,sceneBytes,logoBytes,svgBytes,pngBytes,previewBytes,manifestBytes,font400,font700]=await Promise.all([fs.readFile(files.sourceSvg),fs.readFile(files.scene),fs.readFile(files.logo),fs.readFile(files.svg),fs.readFile(files.png),fs.readFile(files.preview),fs.readFile(files.manifest),fs.readFile("C:/Windows/Fonts/msyh.ttc"),fs.readFile("C:/Windows/Fonts/msyhbd.ttc")]);
  const source=sourceBytes.toString("utf8"),output=svgBytes.toString("utf8"),manifest=JSON.parse(manifestBytes.toString("utf8"));
  const sourceTexts=textNodes(source),outputTexts=textNodes(output);
  assert(sourceTexts.length===19&&outputTexts.length===19,"text node count differs");
  let changed=0,retained=0;
  for(let i=0;i<COPY.length;i+=1){const [oldText,newText]=COPY[i];const matches=sourceTexts.map((node,index)=>node.text===oldText?index:-1).filter((index)=>index>=0);assert(matches.length===1,`source text[${i+1}] matches expected=1 actual=${matches.length}`);const domIndex=matches[0];assert(outputTexts[domIndex].text===newText,`output text[${i+1}] differs`);assert(JSON.stringify(sourceTexts[domIndex].attrs)===JSON.stringify(outputTexts[domIndex].attrs),`text attributes[${i+1}] changed`);if(oldText===newText)retained+=1;else changed+=1;}
  assert(changed===15&&retained===4,"15-change/4-retain contract differs");
  assert(canonicalWithoutText(source)===canonicalWithoutText(output),"SVG differs outside text content/declaration metadata");
  const embeddedLogo=imagePayload(output,"image/svg+xml"),embeddedScene=imagePayload(output,"image/png");
  assert(embeddedLogo.equals(logoBytes),"embedded logo bytes differ");assert(embeddedScene.equals(sceneBytes),"embedded scene bytes differ");
  const [posterMeta,previewMeta]=await Promise.all([sharp(pngBytes).metadata(),sharp(previewBytes).metadata()]);
  assert(posterMeta.width===2048&&posterMeta.height===3072,"poster dimensions differ");assert(previewMeta.width===1024&&previewMeta.height===1536,"preview dimensions differ");
  const hashes={sourceSvg:sha256(sourceBytes),scene:sha256(sceneBytes),logo:sha256(logoBytes),svg:sha256(svgBytes),png:sha256(pngBytes),preview:sha256(previewBytes)};
  const sceneSource=manifest.sources?.scene??manifest.sources?.hero;assert(sceneSource?.sha256.toLowerCase()===hashes.scene,"manifest scene hash differs");assert(manifest.sources?.logo?.sha256.toLowerCase()===hashes.logo,"manifest logo hash differs");
  for(const [name,key] of [["poster.svg","svg"],["poster.png","png"],["poster-preview.png","preview"]])assert(manifest.outputs?.[name]?.sha256.toLowerCase()===hashes[key],`manifest output hash differs: ${name}`);
  const typo=manifest.typography;assert(typo?.family==="Microsoft YaHei"&&typo.isolatedFontconfig===true&&typo.regularWeight===400&&typo.boldWeight===700,"typography manifest differs");
  const declared=typo.localFontCopies??typo.isolatedFontFiles,expectedFonts={"msyh.ttc":sha256(font400),"msyhbd.ttc":sha256(font700)};assert(Array.isArray(declared)&&declared.length===2,"font file evidence differs");declared.forEach((item)=>assert(expectedFonts[item.file]===item.sha256.toLowerCase(),`font hash differs: ${item.file}`));
  const faces=typo.renderEvidence??typo.posterRenderEvidence?.matchedFaces;assert(Array.isArray(faces)&&faces.length===2,"font render evidence differs");assert(/weight:\s*80\b/.test(faces.find((face)=>face.file==="msyh.ttc")?.weight)&&/weight:\s*200\b/.test(faces.find((face)=>face.file==="msyhbd.ttc")?.weight),"font weights differ");
  const visible=outputTexts.map((node)=>node.text).join(" ").replace("资金不托管","");const forbidden=["保证收益","保本","自动赚钱","提供策略","提供数据","正式上线","竞品","托管资金"];assert(!forbidden.some((term)=>visible.includes(term)),"forbidden claim present");
  const result={status:"AUTOMATED_PASS_AWAITING_VISUAL",sourceHashes:{v2Svg:hashes.sourceSvg,scene:hashes.scene,logo:hashes.logo},outputHashes:{svg:hashes.svg,png:hashes.png,preview:hashes.preview},textNodes:19,changed,retained,embeddedBytesEqual:{scene:true,logo:true},dimensions:{poster:[posterMeta.width,posterMeta.height],preview:[previewMeta.width,previewMeta.height]},v2Unchanged:true,brandUnchanged:true,limitations:["copy overflow/collision and small-size legibility require visual inspection"]};
  await fs.writeFile(files.report,`# Poster V3 独立验收\n\n**自动门禁通过，待目视裁决**。V2 SVG \`${hashes.sourceSvg}\`，scene \`${hashes.scene}\`，logo \`${hashes.logo}\`，V3 PNG \`${hashes.png}\`。19节点为15改4留；除文字内容及允许元数据外SVG等价，内嵌字节、尺寸、manifest与字体证据通过。未运行renderer、提交或发布。\n`,"utf8");
  console.log(JSON.stringify(result,null,2));
}

try{await run();}catch(error){console.error(JSON.stringify({status:"FAIL",error:`${error.name}: ${error.message}`}));process.exitCode=1;}
