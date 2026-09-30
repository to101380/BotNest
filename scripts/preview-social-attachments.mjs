// Loopback-only fictional inbox; no credentials or real platform requests.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createHandler } from "../functions/core.js";
import { createStore } from "../functions/store.js";
import { memoryDb } from "../functions/test/memory.js";

const port = Number(process.env.BOTNEST_PREVIEW_PORT || 5193), origin = `http://127.0.0.1:${port}`;
const root = path.resolve(fileURLToPath(new URL("../public/", import.meta.url))), store = createStore(memoryDb());
const objects = new Map(), history = new Map(), key = randomBytes(32).toString("base64");
await store.saveZernioProfile("preview", "preview-profile", Date.now());
for (const platform of ["facebook", "instagram"]) {
  await store.bindZernioPlatform("preview", "preview-profile", platform, { accountId: `preview-${platform}`, platform, username: "demo", displayName: "示範商店" }, Date.now());
  history.set(platform, [{ id: `hello-${platform}`, accountId: `preview-${platform}`, conversationId: `demo-${platform}`, direction: "incoming", message: "請提供照片或說明文件。", createdAt: new Date().toISOString(), attachments: [] }]);
}
const handler = createHandler({ store, authorizeSession: async () => {}, getKey: () => key, getZernioKey: () => "fixture-only",
  verifyToken: async token => { if (token !== "preview") throw Error("Unknown fixture token"); return { uid: "preview", firebase: { sign_in_provider: "google.com" } }; },
  media: { save: async (name, bytes) => objects.set(name, bytes), read: async name => objects.get(name) },
  fetchZernio: async (url, options = {}) => {
    const target = new URL(url), body = options.body ? JSON.parse(options.body) : {}, accountId = body.accountId || target.searchParams.get("accountId");
    const platform = accountId === "preview-instagram" ? "instagram" : "facebook";
    let data = {};
    if (target.pathname.endsWith("/messages") && options.method === "POST") {
      const id = randomUUID();
      history.get(platform).unshift({ id, accountId, conversationId: `demo-${platform}`, direction: "outgoing", message: body.message || "", createdAt: new Date().toISOString(), attachments: body.attachmentUrl ? [{ type: body.attachmentType, url: body.attachmentUrl, filename: decodeURIComponent(new URL(body.attachmentUrl).pathname.split("/").at(-1)) }] : [] });
      data = { success: true, data: { messageId: id } };
    } else if (target.pathname.endsWith("/messages")) data = { messages: history.get(platform), pagination: { hasMore: false } };
    else if (target.pathname.endsWith("/conversations")) data = { data: [{ id: `demo-${platform}`, accountId, platform, participantName: platform === "instagram" ? "IG 示範顧客" : "Messenger 示範顧客", lastMessage: "請提供照片或說明文件。", updatedTime: new Date().toISOString() }], pagination: { hasMore: false } };
    else if (target.pathname.endsWith("/contacts")) data = { contacts: [] };
    else throw Error("Fixture never accesses a real service");
    return new Response(JSON.stringify(data));
  },
});
const bootstrap = `import {createLineInbox} from '/line-inbox.js';
document.body.className='authenticated inbox-open';
for(const id of ['auth-loading','signed-out','account-page','channels-page','assistant-page','customers-page'])document.getElementById(id).hidden=true;
for(const id of ['signed-in','app-nav','ai-page'])document.getElementById(id).hidden=false;
document.title='社群附件｜虛構資料預覽';
createLineInbox().setSession({uid:'preview',getIdToken:async()=> 'preview'},'inbox');`;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.url.startsWith("/api/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      req.rawBody = Buffer.concat(chunks); if (req.rawBody.length) req.body = JSON.parse(req.rawBody.toString());
      req.originalUrl = req.url; req.get = name => name.toLowerCase() === "origin" ? "https://planning-with-ai-52d58.web.app" : req.headers[name.toLowerCase()];
      res.set = (name, value) => { res.setHeader(name, value); return res; };
      res.status = code => { res.statusCode = code; return res; };
      res.json = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value).replaceAll("https://planning-with-ai-52d58.web.app", origin)); };
      res.send = value => res.end(value);
      return await handler(req, res);
    }
    const pathname = new URL(req.url, origin).pathname;
    if (pathname === "/__social-preview.js") { res.setHeader("Content-Type", types[".js"]); return res.end(bootstrap); }
    const filename = path.resolve(root, `.${pathname === "/" ? "/index.html" : decodeURIComponent(pathname)}`);
    if (!filename.startsWith(root + path.sep) && filename !== path.join(root, "index.html")) { res.statusCode = 403; return res.end(); }
    let bytes = await readFile(filename);
    if (filename.endsWith("index.html")) bytes = bytes.toString().replace('src="/app.js"', 'src="/__social-preview.js"');
    if (filename.endsWith("line-inbox.js")) bytes = bytes.toString().replaceAll("https://planning-with-ai-52d58.web.app", origin);
    res.setHeader("Content-Type", types[path.extname(filename)] || "application/octet-stream"); res.end(bytes);
  } catch { res.statusCode = 500; res.end("Preview request failed"); }
}).listen(port, "127.0.0.1", () => console.log(`Fictional data, simulated sends only: ${origin}`));
