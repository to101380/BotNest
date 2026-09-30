// Local UI fixture only: binds loopback, uses invented data, makes no LINE calls.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createHandler, normalizeEvent, seal } from "../functions/core.js";
import { createStore } from "../functions/store.js";
import { memoryDb } from "../functions/test/memory.js";
import { mediaSignature } from "../functions/media.js";
const root = fileURLToPath(new URL("../public/", import.meta.url));
const store = createStore(memoryDb()), key = randomBytes(32).toString("base64");
await store.bind("preview", { channelId: "1234567890", ownerUid: "preview", botUserId: `U${"a".repeat(32)}`, displayName: "BotNest 示範帳號", basicId: "@demo", secret: seal("a".repeat(32), key, "1234567890"), accessToken: seal("demo-only-token", key, "1234567890:access-token"), verifiedAt: Date.now() });
await store.saveAiSettings("1234567890", { enabled: true, instructions: "以繁體中文簡短回覆。", model: "gpt-5.4-mini" }, Date.now());
await store.saveAccountAiSettings("preview", { enabled: true, role: "BotNest 品牌客服", businessInfo: "BotNest 示範花店。營業時間為週一至五上午九點到下午六點，週末公休。", instructions: "使用親切的繁體中文回覆顧客。" }, Date.now());
await store.saveAiKnowledge("preview", "7b61f5d8-cc7a-46f4-b3f4-80f51b3ef124", { title: "配送與退換貨政策", content: "配送時間：下單後三個工作天出貨。台灣本島運費 80 元，訂單滿 1,000 元免運。退款需求請交由真人客服處理。", enabled: true, kind: "text", url: "" }, Date.now());
for (const [i, text] of ["你好，我想了解服務內容。", "可以告訴我目前的營業時間嗎？", "謝謝！我晚點再和你聯絡。"].entries()) {
  await store.ingest("1234567890", normalizeEvent({ type: "message", webhookEventId: `demo-${i}`, timestamp: Date.now() - (3 - i) * 60000, source: { type: "user", userId: `U${"b".repeat(32)}` }, message: { type: "text", id: String(i), text } }));
}
const previewMedia = new Map();
const demoImageId = "11111111-1111-4111-8111-111111111111", demoExpiry = Date.now() + 30 * 86400000;
const demoPath = `/api/line/media/1234567890/${demoImageId}`, demoBytes = await readFile(new URL("line-brand.png", new URL("../public/", import.meta.url)));
previewMedia.set("demo-image", demoBytes);
await store.saveAttachment("1234567890", demoImageId, { id: demoImageId, kind: "image", name: "示範圖片.png", mime: "image/png", size: demoBytes.length, expiresAt: demoExpiry, storagePath: "demo-image", library: true, librarySavedAt: Date.now(), url: `https://planning-with-ai-52d58.web.app${demoPath}?expires=${demoExpiry}&signature=${mediaSignature(demoPath, String(demoExpiry), key)}` });
const handler = createHandler({ store, getKey: () => key,
  authorizeSession: async () => {}, // Only this loopback fixture uses a fake identity.
  openAiConfigured: () => true,
  getOpenAiKey: () => "preview-never-a-real-key",
  fetchOpenAi: async () => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ action: "reply", text: "您好！我們週一至五上午 9 點至下午 6 點營業，週末公休。", reason: "依商家提供的營業資訊（本機模擬）", grounded: true, kind: "answer", sourceIds: ["business:1"] }) }] }] }), { headers: { "Content-Type": "application/json" } }),
  media: { save: async (path, bytes) => previewMedia.set(path, bytes), read: async path => previewMedia.get(path) },
  verifyToken: async token => { if (token !== "preview-token") throw new Error("Invalid preview token"); return { uid: "preview", auth_time: 0, firebase: { sign_in_provider: "google.com" } }; },
  fetchLine: async url => {
    if (url.includes("/v2/bot/profile/")) return { ok: true, status: 200, json: async () => ({ displayName: "小林（示範）" }) };
    if (url.endsWith("/v2/bot/message/push")) return { ok: true, status: 200 };
    throw new Error("Preview never calls LINE");
  },
});
const previewScript = `import { createLineInbox } from '/line-inbox.js';
import { createCustomerManager } from '/customer-manager.js';
import { createAiSettings } from '/ai-settings.js';
document.body.classList.remove('auth-pending');
document.getElementById('auth-loading').hidden=true;
document.body.classList.add('authenticated','inbox-open');
document.getElementById('signed-out').hidden=true;
document.getElementById('signed-in').hidden=false;
document.getElementById('app-nav').hidden=false;
document.getElementById('state').textContent='本機示範';
document.getElementById('status').textContent='這是虛構資料的本機畫面預覽，回覆僅模擬，不會真的傳送到 LINE。請勿在此輸入真實憑證。';
document.getElementById('logout').hidden=true;
const previewUser={uid:'preview',getIdToken:async()=> 'preview-token'};
const inbox=createLineInbox(), customers=createCustomerManager(), assistant=createAiSettings();
function renderPreview(){
  const customerPage=location.hash==='#customers';
  const channelPage=location.hash==='#channels';
  const assistantPage=location.hash==='#assistant';
  document.getElementById('account-page').hidden=true;
  document.getElementById('ai-page').hidden=customerPage||channelPage||assistantPage;
  document.getElementById('assistant-page').hidden=!assistantPage;
  document.getElementById('customers-page').hidden=!customerPage;
  document.getElementById('channels-page').hidden=!channelPage;
  document.body.classList.toggle('customers-open',customerPage);
  document.body.classList.toggle('channels-open',channelPage);
  document.body.classList.toggle('assistant-open',assistantPage);
  for(const [id,active] of [['nav-account',false],['nav-ai',!customerPage&&!channelPage&&!assistantPage],['nav-assistant',assistantPage],['nav-customers',customerPage],['nav-channels',channelPage]]) document.getElementById(id).toggleAttribute('aria-current',active);
  inbox.setSession(previewUser,channelPage?'settings':customerPage||assistantPage?null:'inbox'); customers.setSession(previewUser,customerPage); assistant.setSession(previewUser,assistantPage);
  document.title=(customerPage?'顧客管理':channelPage?'渠道設定':'LINE 收件匣')+'｜本機示範';
}
addEventListener('hashchange',renderPreview); renderPreview();`;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.url.startsWith("/api/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      req.rawBody = Buffer.concat(chunks);
      if (req.rawBody.length) req.body = JSON.parse(req.rawBody.toString("utf8"));
      // Simulate the production origin only inside this loopback-only, fake-token fixture.
      req.originalUrl = req.url; req.get = name => name.toLowerCase() === "origin" ? "https://planning-with-ai-52d58.web.app" : req.headers[name.toLowerCase()];
      res.set = (k, v) => { res.setHeader(k, v); return res; };
      res.status = code => { res.statusCode = code; return res; };
      res.json = data => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data).replaceAll("https://planning-with-ai-52d58.web.app", `http://127.0.0.1:${process.env.BOTNEST_PREVIEW_PORT || 5191}`)); };
      res.send = data => res.end(data);
      return await handler(req, res);
    }
    if (req.url === "/__preview.js") { res.setHeader("Content-Type", types[".js"]); return res.end(previewScript); }
    const pathname = new URL(req.url, "http://localhost").pathname;
    const target = path.resolve(root, `.${pathname === "/" ? "/index.html" : decodeURIComponent(pathname)}`);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) { res.statusCode = 403; return res.end(); }
    let data = await readFile(target);
    if (target.endsWith("index.html")) data = data.toString().replace('src="/app.js"', 'src="/__preview.js"');
    if (target.endsWith("line-inbox.js")) data = data.toString().replaceAll("https://planning-with-ai-52d58.web.app", `http://127.0.0.1:${process.env.BOTNEST_PREVIEW_PORT || 5191}`);
    res.setHeader("Content-Type", types[path.extname(target)] || "application/octet-stream"); res.end(data);
  } catch { res.statusCode = 404; res.end("Not found"); }
}).listen(Number(process.env.BOTNEST_PREVIEW_PORT || 5191), "127.0.0.1", () => console.log(`Demo data only: http://127.0.0.1:${process.env.BOTNEST_PREVIEW_PORT || 5191}`));
