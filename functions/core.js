import { attachInboxAi } from "./inbox-ai.js";
import { createHash, createHmac, timingSafeEqual, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { MEDIA_ORIGIN, mediaSignature, validMediaSignature, validateUpload } from "./media.js";
import { handleAiApi } from "./ai-api.js";
import { AiError, normalizeAiSettings, validateAiSettings } from "./ai-policy.js";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const digest = value => createHash("sha256").update(value).digest("hex");
export function seal(secret, key, channelId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  cipher.setAAD(Buffer.from(channelId));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
}
export function unseal(value, key, channelId) {
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), Buffer.from(value.iv, "base64"));
  cipher.setAAD(Buffer.from(channelId));
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(value.data, "base64")), cipher.final()]).toString("utf8");
}
export function validSignature(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !/^[A-Za-z0-9+/]{43}=$/.test(signature || "")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const actual = Buffer.from(signature, "base64");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}
export function normalizeEvent(event) {
  if (!["message", "unsend"].includes(event?.type)) return null;
  const source = event.source;
  const sourceId = source?.type === "user" ? source.userId : source?.type === "group" ? source.groupId : source?.type === "room" ? source.roomId : null;
  const messageId = event.type === "unsend" ? event.unsend?.messageId : event.message?.id;
  if (!/^[CUR][a-f0-9]{32}$/i.test(sourceId || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId || "") ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(event.webhookEventId || "") || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0) return null;
  const unsent = event.type === "unsend";
  const type = unsent ? "unsend" : event.message.type;
  const labels = { image: "[圖片]", video: "[影片]", audio: "[語音]", file: "[檔案]", sticker: "[貼圖]", location: "[位置]" };
  return {
    eventId: event.webhookEventId,
    conversationId: digest(`${source.type}:${sourceId}`),
    sourceType: source.type,
    sourceId,
    messageId,
    sentAt: event.timestamp,
    type: unsent ? "unsend" : (Object.hasOwn(labels, type) || type === "text" ? type : "other"),
    text: unsent ? "[訊息已收回]" : type === "text" ? String(event.message.text || "").slice(0, 10000) : (labels[type] || "[尚未支援的訊息]"),
    unsent,
  };
}

const CUSTOMER_LIMITS = { name: 100, phone: 30, email: 254, birthday: 10, gender: 20, language: 60, country: 100, city: 100, address: 300, about: 1000, custom1: 300, custom2: 300, custom3: 300 };
const CUSTOMER_GENDERS = new Set(["", "female", "male", "nonbinary", "undisclosed"]);
function cleanCustomer(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "客戶資料格式錯誤。");
  const extra = Object.keys(input).filter(key => !Object.hasOwn(CUSTOMER_LIMITS, key) && key !== "tags");
  if (extra.length) throw new HttpError(400, "客戶資料包含不支援的欄位。");
  const result = {};
  for (const [key, limit] of Object.entries(CUSTOMER_LIMITS)) {
    const value = input[key] ?? "";
    if (typeof value !== "string" || value.length > limit) throw new HttpError(400, "客戶資料內容過長或格式錯誤。");
    result[key] = value.trim();
  }
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new HttpError(400, "請輸入有效的電子信箱。");
  if (result.phone && !/^[0-9+().\-\s]{3,30}$/.test(result.phone)) throw new HttpError(400, "請輸入有效的電話號碼。");
  if (result.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(result.birthday)) throw new HttpError(400, "生日格式錯誤。");
  if (!CUSTOMER_GENDERS.has(result.gender)) throw new HttpError(400, "性別選項錯誤。");
  if (!Array.isArray(input.tags) || input.tags.length > 20) throw new HttpError(400, "標籤最多 20 個。");
  result.tags = [...new Set(input.tags.map(tag => {
    if (typeof tag !== "string" || !tag.trim() || tag.trim().length > 40) throw new HttpError(400, "每個標籤需為 1～40 個字。");
    return tag.trim();
  }))];
  return result;
}

export function createHandler({ store, verifyToken, getKey, getOpenAiKey = () => "", openAiConfigured = () => !!getOpenAiKey(), getZernioKey = () => "", media, fetchLine = fetch, fetchZernio = fetch, fetchOpenAi = fetch, now = Date.now }) {
  const zernioWebhookUrl = "https://planning-with-ai-52d58.web.app/zernio-webhook";
  const zernioWebhookToken = () => createHmac("sha256", Buffer.from(getKey(), "base64")).update("botnest-zernio-webhook-v1").digest("hex");
  let zernioWebhookReady = false, zernioWebhookSetup;
  async function lineRequest(path, options) {
    const response = await fetchLine(`https://api.line.me${path}`, { ...options, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new HttpError(response.status >= 500 || response.status === 429 ? 503 : 400, "LINE 憑證驗證失敗，請確認 Channel ID 與長期 Access Token。");
    return response.json();
  }
  async function authenticated(req) {
    const bearer = /^Bearer (\S+)$/.exec(req.get("authorization") || "");
    if (!bearer) throw new HttpError(401, "請先登入。");
    let user;
    try { user = await verifyToken(bearer[1]); } catch { throw new HttpError(401, "登入已失效，請重新登入。"); }
    if (!user.uid || !["google.com", "password"].includes(user.firebase?.sign_in_provider)) throw new HttpError(403, "請使用正式帳號登入。");
    if (user.firebase.sign_in_provider === "password" && user.email_verified !== true) throw new HttpError(403, "請先完成 Email 驗證，再重新登入。");
    req.securityUid = user.uid;
    await store.aiAttempt(user.uid, "api", now(), 120);
    return user;
  }
  async function zernioRequest(path, options = {}) {
    if (!getZernioKey()) throw new HttpError(503, "Zernio API 尚未設定。");
    let response;
    try {
      response = await fetchZernio(`https://zernio.com/api/v1${path}`, {
        ...options, signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${getZernioKey()}`, "Content-Type": "application/json", ...(options.headers || {}) },
      });
    } catch { throw new HttpError(503, "暫時無法連線 Zernio，請稍後再試。"); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = response.status === 402 ? "Zernio 方案已達可連接帳號上限。" : response.status === 401 || response.status === 403 ? "Zernio API Key 權限不足或已失效。" : response.status === 429 ? "Zernio 請求過於頻繁，請稍後再試。" : "Zernio 暫時無法完成連接。";
      throw new HttpError(response.status >= 500 ? 503 : response.status, message);
    }
    return data;
  }
  async function ensureZernioWebhook() {
    if (zernioWebhookReady) return true;
    if (zernioWebhookSetup) return zernioWebhookSetup;
    zernioWebhookSetup = (async () => {
      const listed = await zernioRequest("/webhooks/settings");
      const hooks = listed.webhooks || listed.data || [];
      const existing = hooks.find(item => item.url === zernioWebhookUrl && (item.events || []).includes("message.received") && item.isActive !== false && item.customHeaders?.["X-BotNest-Webhook"] === zernioWebhookToken());
      if (!existing) await zernioRequest("/webhooks/settings", { method: "POST", body: JSON.stringify({ name: "BotNest Messenger AI", url: zernioWebhookUrl,
        events: ["message.received"], isActive: true, secret: zernioWebhookToken(), customHeaders: { "X-BotNest-Webhook": zernioWebhookToken() } }) });
      zernioWebhookReady = true; return true;
    })().finally(() => { zernioWebhookSetup = null; });
    return zernioWebhookSetup;
  }
  const publicChannel = channel => channel ? ({ channelId: channel.channelId, displayName: channel.displayName, basicId: channel.basicId,
    webhookUrl: `https://planning-with-ai-52d58.web.app/line-webhook/${channel.channelId}`,
    verifiedAt: channel.verifiedAt || null, lastReceivedAt: channel.lastReceivedAt || null, canReply: !!channel.accessToken }) : null;

  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    try {
      const path = new URL(req.originalUrl || req.url, "https://botnest.invalid").pathname;
      if (req.rawBody?.length > 8 * 1024 * 1024) throw new HttpError(413, "請求內容過大。");
      if (path === "/zernio-webhook") {
        if (req.method !== "POST") throw new HttpError(405, "請由 Zernio 傳送 POST Webhook。");
        if (!req.rawBody || req.rawBody.length > 1024 * 1024) throw new HttpError(413, "Webhook 內容過大。");
        const expected = Buffer.from(zernioWebhookToken()), supplied = Buffer.from(req.get("x-botnest-webhook") || "");
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new HttpError(401, "Webhook 驗證失敗。");
        let body; try { body = JSON.parse(req.rawBody.toString("utf8")); } catch { throw new HttpError(400, "Webhook 格式錯誤。"); }
        const eventType = body.event || body.type, payload = body.data || body.payload || body;
        if (eventType !== "message.received") return res.status(200).json({ ok: true, ignored: true });
        const message = payload.message || body.message || {}, conversation = payload.conversation || body.conversation || {}, account = payload.account || body.account || {};
        const accountId = String(account.accountId || account.id || account._id || message.accountId || payload.accountId || "");
        // Real Messenger webhooks use Mongo ids in both conversation.id and message.conversationId.
        // The inbox list and its controls use platformConversationId; prefer it so both paths share state.
        const remoteConversationId = String(conversation.platformConversationId || payload.conversationId || message.conversationId || conversation.id || conversation._id || "");
        const remoteMessageId = String(message.platformMessageId || message.id || message._id || payload.messageId || "");
        const platform = String(message.platform || payload.platform || account.platform || conversation.platform || "").toLowerCase();
        const text = String(message.text ?? message.message ?? payload.text ?? "").trim();
        const direction = String(message.direction || payload.direction || "incoming").toLowerCase();
        if (!["facebook", "instagram"].includes(platform) || direction === "outgoing" || !accountId || !remoteConversationId || !remoteMessageId) return res.status(200).json({ ok: true, ignored: true });
        if ([accountId, remoteConversationId, remoteMessageId].some(value => value.length > 512 || /[\u0000-\u001f]/.test(value))) throw new HttpError(400, "Webhook 識別資料無效。");
        const owner = await store.zernioOwnerByAccount(accountId, platform);
        if (!owner) return res.status(200).json({ ok: true, ignored: true });
        const timestamp = Date.parse(message.createdAt || payload.createdAt || body.createdAt || body.timestamp);
        const sender = message.sender || payload.sender || {};
        const saved = await store.ingestZernio(owner.uid, { eventId: String(body.id || body.eventId || `${remoteMessageId}:received`).slice(0, 512), accountId, remoteConversationId, remoteMessageId, provider: platform, type: text ? "text" : "unsupported",
          text: text.slice(0, 10000), sentAt: Number.isFinite(timestamp) ? timestamp : now(), displayName: String(sender.name || conversation.participantName || (platform === "instagram" ? "Instagram 使用者" : "Facebook 使用者")).slice(0, 100),
          pictureUrl: String(sender.avatarUrl || sender.picture || conversation.participantPicture || "").slice(0, 2048) });
        return res.status(200).json({ ok: true, created: saved.created });
      }
      if ((path === "/zernio-callback" && req.method === "GET") || (path === "/api/zernio/complete" && req.method === "POST")) {
        const completing = path === "/api/zernio/complete";
        const callback = completing ? new URLSearchParams(req.body || {}) : new URL(req.originalUrl || req.url, "https://botnest.invalid").searchParams;
        const redirect = new URL("https://planning-with-ai-52d58.web.app/");
        redirect.hash = "channels";
        if (callback.get("error")) {
          redirect.searchParams.set("zernio", "error");
          redirect.searchParams.set("reason", String(callback.get("error")).slice(0, 80));
          return res.redirect(302, redirect.toString());
        }
        const platform = callback.get("connected");
        const profileId = callback.get("profileId"), accountId = callback.get("accountId");
        if (!["facebook", "instagram"].includes(platform) || !/^[a-f0-9]{24}$/i.test(profileId || "") || !/^[a-f0-9]{24}$/i.test(accountId || "")) throw new HttpError(400, "社群授權回傳資料不完整。");
        const stateToken = callback.get("state");
        if (!/^[A-Za-z0-9_-]{43}$/.test(stateToken || "")) throw new HttpError(403, "社群授權狀態無效，請重新連接。");
        if (!completing) {
          // The same-origin landing page supplies both the original login and the
          // approved-device cookie. GET callbacks never bind accounts.
          const landing = new URL("https://planning-with-ai-52d58.web.app/oauth-complete.html");
          landing.hash = new URLSearchParams({ connected: platform, profileId, accountId, state: stateToken }).toString();
          return res.redirect(302, landing.toString());
        }
        const user = await authenticated(req);
        const owner = await store.zernioOwner(profileId);
        if (!owner || owner.uid !== user.uid) throw new HttpError(403, "請使用開始連接的原帳號與裝置完成授權。");
        await store.validateZernioState(owner.uid, platform, profileId, digest(stateToken), now());
        const listed = await zernioRequest(`/accounts?profileId=${encodeURIComponent(profileId)}&platform=${platform}`);
        const match = (listed.accounts || []).find(item => item._id === accountId && item.platform === platform);
        if (!match) throw new HttpError(403, "無法驗證已授權的社群帳號。");
        await store.bindZernioPlatform(owner.uid, profileId, platform, { accountId, username: String(match.username || "").slice(0, 120), displayName: String(match.displayName || match.username || platform).slice(0, 120), platform }, now(), digest(stateToken));
        redirect.searchParams.set("platform", platform);
        redirect.searchParams.set("zernio", "connected");
        return res.json({ redirectUrl: redirect.toString() });
      }
      const mediaRoute = /^\/api\/line\/media\/(\d{5,20})\/([a-f0-9-]{36})$/.exec(path);
      if (mediaRoute && ["GET", "HEAD"].includes(req.method)) {
        const params = new URL(req.originalUrl || req.url, MEDIA_ORIGIN).searchParams;
        if (!validMediaSignature(path, params.get("expires"), params.get("signature"), getKey(), now())) throw new HttpError(403, "附件連結無效或已過期。");
        const attachment = await store.getAttachment(mediaRoute[1], mediaRoute[2]);
        if (!attachment || attachment.expiresAt <= now()) throw new HttpError(404, "附件已過期或不存在。");
        if (attachment.messageId && (await store.getMessage(mediaRoute[1], attachment.conversationId, attachment.messageId))?.unsent) throw new HttpError(404, "訊息已收回。");
        res.set("Content-Type", attachment.mime);
        res.set("Content-Disposition", `${attachment.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
        res.set("Content-Security-Policy", "default-src 'none'; sandbox");
        return res.status(200).send(req.method === "HEAD" ? "" : await media.read(attachment.storagePath));
      }
      const webhook = /^\/line-webhook\/(\d{5,20})$/.exec(path);
      if (webhook) {
        if (req.method !== "POST") throw new HttpError(405, "請由 LINE 傳送 POST Webhook。");
        if (!req.rawBody || req.rawBody.length > 1024 * 1024) throw new HttpError(413, "Webhook 內容過大。");
        const channel = await store.getChannel(webhook[1]);
        if (!channel) throw new HttpError(404, "找不到 OA。");
        if (!validSignature(req.rawBody, req.get("x-line-signature"), unseal(channel.secret, getKey(), channel.channelId))) throw new HttpError(401, "Webhook 簽章無效。");
        let body;
        try { body = JSON.parse(req.rawBody.toString("utf8")); } catch { throw new HttpError(400, "Webhook 格式錯誤。"); }
        if (body.destination !== channel.botUserId || !Array.isArray(body.events) || body.events.length > 100) throw new HttpError(400, "Webhook 帳號或事件格式不符。");
        // Acknowledge only after durable writes. Redelivery is deduplicated transactionally.
        const receivedAt = now();
        for (const event of body.events) {
          const normalized = normalizeEvent(event);
          if (normalized) {
            // Keep the short-lived credential encrypted and out of public message DTOs.
            // Redelivery may carry an already-used token, so it cannot start a Reply attempt.
            const reply = normalized.type === "text" && receivedAt - normalized.sentAt < 19 * 60000 && !event.deliveryContext?.isRedelivery &&
              typeof event.replyToken === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(event.replyToken)
              ? { replyToken: seal(event.replyToken, getKey(), `${channel.channelId}:${normalized.messageId}:reply-token`), replyExpiresAt: receivedAt + 45000 }
              : null;
            await store.ingest(channel.channelId, normalized, reply);
          }
        }
        await store.markVerified(channel.channelId, now(), body.events.some(event => event.type === "message"));
        return res.status(200).json({ ok: true });
      }
      if (path === "/api/line/health" && req.method === "GET") return res.json({ ok: true });
      if (path.startsWith("/api/ai/")) return await handleAiApi({ user: await authenticated(req), path, req, res, store, getOpenAiKey, openAiConfigured, fetchOpenAi, zernioRequest, now });
      if (path.startsWith("/api/zernio/")) {
        const user = await authenticated(req);
        if (path === "/api/zernio/account" && req.method === "GET") {
          const value = await store.zernioAccount(user.uid);
          let webhookReady = false;
          if (getZernioKey()) try { webhookReady = await ensureZernioWebhook(); } catch { /* The inbox remains available while webhook setup is retried later. */ }
          return res.json({ configured: !!getZernioKey(), webhookReady, profileId: value?.profileId || null, facebook: value?.facebook || null, instagram: value?.instagram || null });
        }
        if (["/api/zernio/connect/facebook", "/api/zernio/connect/instagram"].includes(path) && req.method === "POST") {
          const platform = path.split("/").at(-1);
          if (!Number.isSafeInteger(user.auth_time) || now() / 1000 - user.auth_time > 600 || user.auth_time > now() / 1000 + 60) throw new HttpError(401, "連接社群帳號前請重新登入。");
          await store.aiAttempt(user.uid, "social-connect", now(), 5);
          const origin = req.get("origin");
          if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站連接社群帳號。");
          let value = await store.zernioAccount(user.uid), profileId = value?.profileId;
          if (!profileId) {
            const created = await zernioRequest("/profiles", { method: "POST", body: JSON.stringify({ name: String(user.name || user.email || "BotNest customer").slice(0, 80) }) });
            profileId = created.profile?._id;
            if (!/^[a-f0-9]{24}$/i.test(profileId || "")) throw new HttpError(503, "Zernio Profile 建立失敗。");
            await store.saveZernioProfile(user.uid, profileId, now());
          }
          const stateToken = randomBytes(32).toString("base64url");
          await store.saveZernioState(user.uid, platform, profileId, digest(stateToken), now());
          const redirectUrl = "https://planning-with-ai-52d58.web.app/zernio-callback?state=" + stateToken;
          const connected = await zernioRequest(`/connect/${platform}?profileId=${encodeURIComponent(profileId)}&redirect_url=${encodeURIComponent(redirectUrl)}${platform === "instagram" ? "&loginMethod=instagram_login" : ""}`);
          if (typeof connected.authUrl !== "string" || !/^https:\/\//i.test(connected.authUrl)) throw new HttpError(503, "Zernio 未回傳授權網址。");
          return res.json({ authUrl: connected.authUrl });
        }
        const query = new URL(req.originalUrl || req.url, "https://botnest.invalid").searchParams;
        const platform = query.get("platform") || "facebook";
        if (!["facebook", "instagram"].includes(platform)) throw new HttpError(400, "不支援的訊息渠道。");
        const zernio = await store.zernioAccount(user.uid), social = zernio?.[platform];
        if (!social?.accountId) throw new HttpError(409, "請先在渠道設定連接此社群帳號。");
        const customerRoute = path === "/api/zernio/customer" || path === "/api/zernio/customer/notes" || /^\/api\/zernio\/customer\/notes\/[a-f0-9-]{36}$/.test(path);
        if (customerRoute) {
          const remoteId = query.get("conversationId");
          if (!remoteId || remoteId.length > 512 || /[\u0000-\u001f]/.test(remoteId)) throw new HttpError(400, "社群對話參數無效。");
          const customerId = digest(`${social.accountId}:${remoteId}`);
          if (path === "/api/zernio/customer" && req.method === "GET") return res.json({ customer: await store.zernioCustomer(user.uid, customerId) });
          const origin = req.get("origin");
          if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站更新客戶資料。");
          if (path === "/api/zernio/customer" && req.method === "PUT") return res.json({ customer: await store.saveZernioCustomer(user.uid, customerId, cleanCustomer(req.body), now()) });
          if (path === "/api/zernio/customer/notes" && req.method === "POST") {
            const text = req.body?.text;
            if (typeof text !== "string" || !text.trim() || text.trim().length > 1000) throw new HttpError(400, "記事需為 1～1000 個字。");
            return res.json({ customer: await store.addZernioCustomerNote(user.uid, customerId, text.trim(), now()) });
          }
          const noteId = /^\/api\/zernio\/customer\/notes\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(path)?.[1];
          if (noteId && req.method === "DELETE") return res.json({ customer: await store.deleteZernioCustomerNote(user.uid, customerId, noteId, now()) });
          throw new HttpError(405, "不支援的客戶資料操作。");
        }
        if (path === "/api/zernio/conversations" && req.method === "GET") {
          const cursor = query.get("cursor");
          if (cursor && (cursor.length > 1024 || /[\u0000-\u001f]/.test(cursor))) throw new HttpError(400, "分頁參數無效。");
          const data = await zernioRequest(`/inbox/conversations?accountId=${encodeURIComponent(social.accountId)}&platform=${platform}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          let contacts = [];
          if ((data.data || []).some(item => !item.participantPicture)) {
            try { contacts = (await zernioRequest(`/contacts?accountId=${encodeURIComponent(social.accountId)}&platform=${platform}&limit=200`)).contacts || []; }
            catch { /* Contact avatars are an optional fallback and must not block the inbox. */ }
          }
          const contactByParticipant = new Map(contacts.map(item => [String(item.platformIdentifier || ""), item]));
          const items = (Array.isArray(data.data) ? data.data : []).filter(item => item.platform === platform && item.accountId === social.accountId).map(item => ({
            id: `${platform}-${digest(`${social.accountId}:${item.id}`)}`, provider: platform, remoteId: String(item.id), sourceType: "user", sourceId: String(item.participantId || ""),
            displayName: String(item.participantName || `${platform === "instagram" ? "Instagram" : "Messenger"} 使用者`).slice(0, 100), pictureUrl: String(item.participantPicture || contactByParticipant.get(String(item.participantId || ""))?.avatarUrl || (platform === "facebook" && /^\d{5,30}$/.test(String(item.participantId || "")) ? `https://graph.facebook.com/${item.participantId}/picture?type=large` : "")).slice(0, 2048),
            lastText: String(item.lastMessage || "").slice(0, 10000), updatedAt: Number.isFinite(Date.parse(item.updatedTime)) ? Date.parse(item.updatedTime) : now(), unreadCount: Number(item.unreadCount || 0),
          }));
          await Promise.all(items.map(async item => { item.customer = await store.zernioCustomer(user.uid, digest(`${social.accountId}:${item.remoteId}`)); }));
          await attachInboxAi(store, user.uid, items, platform, now());
          return res.json({ items, next: data.pagination?.hasMore && typeof data.pagination.nextCursor === "string" ? data.pagination.nextCursor : null });
        }
        if (path === "/api/zernio/messages" && req.method === "GET") {
          const conversationId = query.get("conversationId"), cursor = query.get("cursor");
          if (!conversationId || conversationId.length > 512 || /[\u0000-\u001f]/.test(conversationId) || (cursor && (cursor.length > 1024 || /[\u0000-\u001f]/.test(cursor)))) throw new HttpError(400, "社群對話參數無效。");
          const data = await zernioRequest(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages?accountId=${encodeURIComponent(social.accountId)}&limit=50&sortOrder=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          const labels = { image: "[圖片]", video: "[影片]", audio: "[語音]", file: "[檔案]", sticker: "[貼圖]", share: "[分享內容]" };
          const items = (Array.isArray(data.messages) ? data.messages : []).filter(item => item.accountId === social.accountId && item.conversationId === conversationId).map(item => {
            const attachment = Array.isArray(item.attachments) ? item.attachments[0] : null, kind = attachment?.type;
            const sentAt = Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : now();
            const normalizedAttachment = attachment && typeof attachment.url === "string" ? { kind: kind === "image" ? "image" : "file", name: attachment.filename || labels[kind] || "社群附件", url: attachment.url.slice(0, 4096), external: true, expiresAt: sentAt + 86400000 } : null;
            return { id: `${platform}-${digest(`${social.accountId}:${item.id}`)}`, remoteId: String(item.id), direction: item.direction === "outgoing" ? "outgoing" : "incoming", type: kind || "text", text: String(item.message || labels[kind] || "").slice(0, 10000), sentAt, unsent: !!item.isDeleted, status: item.deliveryStatus || (item.direction === "outgoing" ? "sent" : undefined), ...(normalizedAttachment ? { attachment: normalizedAttachment } : {}) };
          });
          return res.json({ items, next: data.pagination?.hasMore && typeof data.pagination.nextCursor === "string" ? data.pagination.nextCursor : null });
        }
        if (path === "/api/zernio/messages" && req.method === "POST") {
          const origin = req.get("origin");
          if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站回覆社群訊息。");
          const { conversationId, text, operationId } = req.body || {};
          if (typeof conversationId !== "string" || !conversationId || conversationId.length > 512 || /[\u0000-\u001f]/.test(conversationId) || typeof text !== "string" || !text.trim() || text.length > 5000 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId || "")) throw new HttpError(400, "社群回覆格式錯誤。");
          await store.zernioSendAttempt(user.uid, now());
          await store.pauseAiForHuman(user.uid, platform, digest(`${social.accountId}:${conversationId}`), now());
          const data = await zernioRequest(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", headers: { "Idempotency-Key": operationId }, body: JSON.stringify({ accountId: social.accountId, message: text.trim() }) });
          const messageId = String(data.messageId || data.data?.messageId || `out-${operationId}`);
          return res.json({ message: { id: `${platform}-${digest(`${social.accountId}:${messageId}`)}`, remoteId: messageId, operationId, direction: "outgoing", type: "text", text: text.trim(), sentAt: now(), status: "sent", unsent: false } });
        }
        throw new HttpError(404, "找不到 Zernio API。");
      }
      if (!path.startsWith("/api/line/")) throw new HttpError(404, "找不到頁面。");
      const user = await authenticated(req);
      if (path === "/api/line/account" && req.method === "GET") return res.json({ channel: publicChannel(await store.account(user.uid)) });
      if (path === "/api/line/account" && req.method === "POST") {
        if (!Number.isFinite(user.auth_time) || now() / 1000 - user.auth_time > 600) throw new HttpError(401, "綁定 OA 前請先登出並重新登入，再於 10 分鐘內送出。");
        const origin = req.get("origin");
        if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站綁定 OA。");
        const { channelId, channelSecret, accessToken } = req.body || {};
        if (!/^\d{5,20}$/.test(channelId || "") || !/^[a-f0-9]{32}$/i.test(channelSecret || "") || typeof accessToken !== "string" || accessToken.length < 30 || accessToken.length > 4096 || /\s/.test(accessToken)) throw new HttpError(400, "請輸入有效的 Channel ID、Channel Secret 與長期 Access Token。");
        await store.bindingAttempt(user.uid, now());
        const tokenInfo = await lineRequest("/v2/oauth/verify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: accessToken }).toString() });
        if (String(tokenInfo.client_id) !== channelId) throw new HttpError(400, "Access Token 不屬於這個 Channel ID。");
        const bot = await lineRequest("/v2/bot/info", { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!/^U[a-f0-9]{32}$/i.test(bot.userId || "")) throw new HttpError(400, "無法取得 OA 資料。");
        const channel = { channelId, ownerUid: user.uid, botUserId: bot.userId, displayName: String(bot.displayName || "LINE OA").slice(0, 100),
          basicId: String(bot.basicId || "").slice(0, 100), secret: seal(channelSecret, getKey(), channelId),
          accessToken: seal(accessToken, getKey(), `${channelId}:access-token`), verifiedAt: null };
        await store.bind(user.uid, channel);
        // Credentials remain encrypted server-side and are never returned to the browser.
        return res.json({ channel: publicChannel(channel) });
      }
      const account = await store.account(user.uid);
      if (!account || account.ownerUid !== user.uid) throw new HttpError(404, "請先綁定 OA。");
      if (path === "/api/line/ai-settings" && req.method === "GET") {
        const ai = normalizeAiSettings(await store.accountAiSettings(user.uid));
        return res.json({ settings: { ...ai, configured: openAiConfigured() } });
      }
      if (path === "/api/line/ai-settings" && req.method === "PUT") {
        const origin = req.get("origin");
        if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站更新 AI 設定。");
        const enabled = req.body?.enabled, instructions = req.body?.instructions ?? "";
        if (typeof enabled !== "boolean" || typeof instructions !== "string" || instructions.length > 4000) throw new HttpError(400, "AI 設定格式錯誤，指示詞最多 4000 字。");
        if (enabled && !openAiConfigured()) throw new HttpError(409, "請先在 Firebase 設定 OpenAI API Key。");
        const settings = await store.saveAccountAiSettings(user.uid, validateAiSettings({ enabled, instructions }, await store.accountAiSettings(user.uid)), now());
        return res.json({ settings: { ...settings, configured: openAiConfigured() } });
      }
      const query = new URL(req.originalUrl || req.url, "https://botnest.invalid").searchParams;
      const before = query.get("before");
      if (before && !/^[a-zA-Z0-9_-]{1,128}$/.test(before)) throw new HttpError(400, "分頁參數無效。");
      const upload = /^\/api\/line\/conversations\/([a-f0-9]{64})\/attachments$/.exec(path);
      if (upload && req.method === "POST") {
        const origin = req.get("origin");
        if (origin && ![MEDIA_ORIGIN, "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站上傳。");
        if (!account.accessToken) throw new HttpError(409, "請先更新 OA 連線憑證。");
        const file = validateUpload(req.body);
        await store.reserveUpload(account.channelId, upload[1], file.size, now());
        const id = randomUUID(), expiresAt = now() + 30 * 86400000;
        const mediaPath = `/api/line/media/${account.channelId}/${id}`;
        const url = `${MEDIA_ORIGIN}${mediaPath}?expires=${expiresAt}&signature=${mediaSignature(mediaPath, String(expiresAt), getKey())}`;
        const attachment = { id, conversationId: upload[1], name: file.name, kind: file.kind, mime: file.mime, size: file.size, expiresAt, url, storagePath: `botnest/${account.channelId}/${id}` };
        await media.save(attachment.storagePath, file.bytes, file.mime);
        await store.saveAttachment(account.channelId, id, attachment);
        return res.json({ attachment: { id, name: file.name, kind: file.kind, size: file.size, url, expiresAt } });
      }
      if (path === "/api/line/conversations" && req.method === "GET") {
        const page = await store.conversations(account.channelId, before);
        if (account.accessToken) await Promise.all(page.items.map(async item => {
          if (!["user", "group"].includes(item.sourceType) || item.profileRefreshAfter > now()) return;
          if (!await store.claimProfile(account.channelId, item.id, now())) return;
          let profile = { profileRefreshAfter: now() + 3600000 };
          try {
            const token = unseal(account.accessToken, getKey(), `${account.channelId}:access-token`);
            const endpoint = item.sourceType === "user" ? `/v2/bot/profile/${encodeURIComponent(item.sourceId)}` : `/v2/bot/group/${encodeURIComponent(item.sourceId)}/summary`;
            const response = await fetchLine(`https://api.line.me${endpoint}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
            if (response.ok) {
              const data = await response.json();
              const pictureUrl = typeof data.pictureUrl === "string" && /^https:\/\/[^/]+\.line-scdn\.net\//i.test(data.pictureUrl) ? data.pictureUrl.slice(0, 2048) : "";
              profile = { displayName: String(data.displayName || data.groupName || "").slice(0, 100), pictureUrl, profileRefreshAfter: now() + 86400000 };
            } else if (response.status === 404) profile = { ...profile, displayName: "", pictureUrl: "" };
          } catch { /* Profile lookup must not prevent reading conversations. */ }
          await store.saveProfile(account.channelId, item.id, profile);
          Object.assign(item, profile);
        }));
        await attachInboxAi(store, user.uid, page.items, "line", now());
        return res.json(page);
      }
      const customer = /^\/api\/line\/conversations\/([a-f0-9]{64})\/customer$/.exec(path);
      if (customer && req.method === "PUT") {
        const origin = req.get("origin");
        if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站更新客戶資料。");
        return res.json({ customer: await store.saveCustomer(account.channelId, customer[1], cleanCustomer(req.body), now()) });
      }
      const customerNotes = /^\/api\/line\/conversations\/([a-f0-9]{64})\/customer\/notes$/.exec(path);
      if (customerNotes && req.method === "POST") {
        const origin = req.get("origin");
        if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站新增記事。");
        const text = req.body?.text;
        if (typeof text !== "string" || !text.trim() || text.trim().length > 1000) throw new HttpError(400, "記事需為 1～1000 個字。");
        return res.json({ customer: await store.addCustomerNote(account.channelId, customerNotes[1], text.trim(), now()) });
      }
      const customerNote = /^\/api\/line\/conversations\/([a-f0-9]{64})\/customer\/notes\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(path);
      if (customerNote && req.method === "DELETE") {
        const origin = req.get("origin");
        if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站刪除記事。");
        return res.json({ customer: await store.deleteCustomerNote(account.channelId, customerNote[1], customerNote[2], now()) });
      }
      const messages = /^\/api\/line\/conversations\/([a-f0-9]{64})\/messages$/.exec(path);
      if (messages && req.method === "GET") {
        const page = await store.messages(account.channelId, messages[1], before);
        if (account.accessToken && media) {
          const pending = page.items.filter(item => item.type === "image" && item.direction === "incoming" && !item.unsent && !item.attachment && !(item.imageRetryAfter > now())).slice(0, 3);
          for (const item of pending) {
            if (!await store.claimIncomingImage(account.channelId, messages[1], item.id, now())) continue;
            let patch;
            try {
              const token = unseal(account.accessToken, getKey(), `${account.channelId}:access-token`);
              const response = await fetchLine(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(item.id)}/content`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
              if (!response.ok) throw new HttpError(response.status, "LINE 圖片暫時無法取得");
              const chunks = []; let size = 0;
              for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 10 * 1024 * 1024) throw new HttpError(413, "圖片超過 10 MB");
                chunks.push(Buffer.from(chunk));
              }
              const bytes = Buffer.concat(chunks);
              const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
              const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
              if (!png && !jpeg) throw new HttpError(415, "圖片格式無法預覽");
              const id = randomUUID(), expiresAt = now() + 30 * 86400000, name = `LINE-${item.id}.${png ? "png" : "jpg"}`;
              const mediaPath = `/api/line/media/${account.channelId}/${id}`;
              const url = `${MEDIA_ORIGIN}${mediaPath}?expires=${expiresAt}&signature=${mediaSignature(mediaPath, String(expiresAt), getKey())}`;
              const attachment = { id, conversationId: messages[1], messageId: item.id, name, kind: "image", mime: png ? "image/png" : "image/jpeg", size, expiresAt, url, storagePath: `botnest/${account.channelId}/${id}` };
              await media.save(attachment.storagePath, bytes, attachment.mime);
              await store.saveAttachment(account.channelId, id, attachment);
              patch = { attachment: { id, name, kind: "image", size, expiresAt, url }, imageNote: "", imageRetryAfter: 0 };
            } catch (error) {
              const permanent = [404, 410, 413, 415].includes(error.status);
              patch = { imageNote: permanent ? "圖片已過期、過大或格式不支援，請對方重新傳送。" : "圖片暫時載入失敗，稍後會自動重試。", imageRetryAfter: now() + (permanent ? 86400000 : 60000) };
            }
            const updated = await store.finishIncomingImage(account.channelId, messages[1], item.id, patch);
            if (updated) { for (const key of Object.keys(item)) delete item[key]; Object.assign(item, updated); }
          }
        }
        return res.json(page);
      }
      if (messages && req.method === "POST") {
        const origin = req.get("origin");
        if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站回覆。");
        const { text = "", operationId, attachmentId = null } = req.body || {};
        if (typeof text !== "string" || (!attachmentId && !text.trim()) || text.length > 5000 || (attachmentId && !/^[a-f0-9-]{36}$/.test(attachmentId)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId || "")) throw new HttpError(400, "請輸入 1～5000 字的回覆或選取附件。");
        if (!account.accessToken) throw new HttpError(409, "請先更新 OA 連線憑證，啟用網頁回覆。");
        const token = unseal(account.accessToken, getKey(), `${account.channelId}:access-token`);
        const operation = await store.prepareReply(account.channelId, messages[1], operationId, text, now(), attachmentId);
        if (operation.claimed) await store.pauseAiForHuman(user.uid, "line", messages[1], now());
        if (!operation.claimed) return res.status(["sent", "failed"].includes(operation.status) ? 200 : 202).json({ message: operation.message });
        let state = "uncertain", note = "傳送結果尚未確認，請用這則訊息的重試按鈕確認，避免另發一則。";
        try {
          const response = await fetchLine("https://api.line.me/v2/bot/message/push", {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Line-Retry-Key": operation.retryKey },
            body: JSON.stringify({ to: operation.to, messages: operation.lineMessages || [{ type: "text", text: operation.text }] }), signal: AbortSignal.timeout(12000),
          });
          if (response.ok || (response.status === 409 && response.headers.get("x-line-accepted-request-id"))) { state = "sent"; note = "已交給 LINE，這不代表對方已收到或已讀。"; }
          else if (response.status >= 400 && response.status < 500 && response.status !== 409) {
            state = operation.retried ? "uncertain" : "failed";
            note = response.status === 429 ? "LINE 拒絕傳送，請檢查訊息額度或稍後再傳。" : [401, 403].includes(response.status) ? "LINE 憑證無效或權限不足，請更新 OA 連線憑證。" : "LINE 拒絕這則訊息，請檢查收件對象與訊息內容。";
          }
        } catch { /* Network errors have ambiguous outcomes. Retry only with the saved key. */ }
        const message = await store.finishReply(account.channelId, operationId, state, note);
        return res.status(state === "uncertain" ? 202 : 200).json({ message });
      }
      throw new HttpError(404, "找不到頁面。");
    } catch (error) {
      // Never log headers, credentials, LINE payloads, or message bodies.
      const expected = error instanceof HttpError || error instanceof AiError;
      if (!expected) console.error("BotNest request failed", { code: String(error.code || error.name || "unknown").slice(0, 80) });
      return res.status(expected ? error.status : 503).json({ error: expected ? error.message : "服務暫時無法使用，請稍後重試。" });
    }
  };
}
