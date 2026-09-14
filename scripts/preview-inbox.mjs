// Local UI fixture only: binds loopback, uses invented data, makes no LINE calls.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createHandler, normalizeEvent, seal } from "../functions/core.js";
import { createStore } from "../functions/store.js";
import { memoryDb } from "../functions/test/memory.js";
const root = fileURLToPath(new URL("../public/", import.meta.url));
const store = createStore(memoryDb()), key = randomBytes(32).toString("base64");
await store.bind("preview", { channelId: "1234567890", ownerUid: "preview", botUserId: `U${"a".repeat(32)}`, displayName: "BotNest 示範帳號", basicId: "@demo", secret: seal("a".repeat(32), key, "1234567890"), verifiedAt: Date.now() });
for (const [i, text] of ["你好，我想了解服務內容。", "可以告訴我目前的營業時間嗎？", "謝謝！我晚點再和你聯絡。"].entries()) {
  await store.ingest("1234567890", normalizeEvent({ type: "message", webhookEventId: `demo-${i}`, timestamp: Date.now() - (3 - i) * 60000, source: { type: "user", userId: `U${"b".repeat(32)}` }, message: { type: "text", id: String(i), text } }));
}
const handler = createHandler({ store, getKey: () => key,
  verifyToken: async token => { if (token !== "preview-token") throw new Error("Invalid preview token"); return { uid: "preview", auth_time: 0, firebase: { sign_in_provider: "google.com" } }; },
  fetchLine: async () => { throw new Error("Preview never calls LINE"); },
});
const previewScript = `import { createLineInbox } from '/line-inbox.js';
document.body.classList.add('authenticated','inbox-open');
document.getElementById('signed-out').hidden=true;
document.getElementById('signed-in').hidden=false;
document.getElementById('account-page').hidden=true;
document.getElementById('ai-page').hidden=false;
document.getElementById('app-nav').hidden=false;
document.getElementById('nav-ai').setAttribute('aria-current','page');
document.getElementById('state').textContent='本機示範';
document.getElementById('status').textContent='這是虛構資料的本機畫面預覽，尚未接通 LINE。請勿在此輸入真實憑證。';
document.getElementById('logout').hidden=true;
document.title='LINE 收件匣｜本機示範';
createLineInbox().setSession({uid:'preview',getIdToken:async()=> 'preview-token'},true);`;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.url.startsWith("/api/line/")) {
      req.originalUrl = req.url; req.get = name => req.headers[name.toLowerCase()];
      res.set = (k, v) => { res.setHeader(k, v); return res; };
      res.status = code => { res.statusCode = code; return res; };
      res.json = data => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      return await handler(req, res);
    }
    if (req.url === "/__preview.js") { res.setHeader("Content-Type", types[".js"]); return res.end(previewScript); }
    const pathname = new URL(req.url, "http://localhost").pathname;
    const target = path.resolve(root, `.${pathname === "/" ? "/index.html" : decodeURIComponent(pathname)}`);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) { res.statusCode = 403; return res.end(); }
    let data = await readFile(target);
    if (target.endsWith("index.html")) data = data.toString().replace('src="/app.js"', 'src="/__preview.js"');
    res.setHeader("Content-Type", types[path.extname(target)] || "application/octet-stream"); res.end(data);
  } catch { res.statusCode = 404; res.end("Not found"); }
}).listen(5191, "127.0.0.1", () => console.log("Demo data only: http://127.0.0.1:5191"));
