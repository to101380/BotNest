import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

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

export function createHandler({ store, verifyToken, getKey, fetchLine = fetch, now = Date.now }) {
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
    if (!user.uid || !["google.com", "facebook.com", "password"].includes(user.firebase?.sign_in_provider)) throw new HttpError(403, "請使用正式帳號登入。");
    if (user.firebase.sign_in_provider === "password" && user.email_verified !== true) throw new HttpError(403, "請先完成 Email 驗證，再重新登入。");
    return user;
  }
  const publicChannel = channel => channel ? ({ channelId: channel.channelId, displayName: channel.displayName, basicId: channel.basicId,
    webhookUrl: `https://planning-with-ai-52d58.web.app/line-webhook/${channel.channelId}`,
    verifiedAt: channel.verifiedAt || null, lastReceivedAt: channel.lastReceivedAt || null, canReply: !!channel.accessToken }) : null;

  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    try {
      const path = new URL(req.originalUrl || req.url, "https://botnest.invalid").pathname;
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
        for (const event of body.events) {
          const normalized = normalizeEvent(event);
          if (normalized) await store.ingest(channel.channelId, normalized);
        }
        await store.markVerified(channel.channelId, now(), body.events.some(event => event.type === "message"));
        return res.status(200).json({ ok: true });
      }
      if (path === "/api/line/health" && req.method === "GET") return res.json({ ok: true });
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
      const query = new URL(req.originalUrl || req.url, "https://botnest.invalid").searchParams;
      const before = query.get("before");
      if (before && !/^[a-zA-Z0-9_-]{1,128}$/.test(before)) throw new HttpError(400, "分頁參數無效。");
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
        return res.json(page);
      }
      const messages = /^\/api\/line\/conversations\/([a-f0-9]{64})\/messages$/.exec(path);
      if (messages && req.method === "GET") return res.json(await store.messages(account.channelId, messages[1], before));
      if (messages && req.method === "POST") {
        const origin = req.get("origin");
        if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw new HttpError(403, "請從正式網站回覆。");
        const { text, operationId } = req.body || {};
        if (typeof text !== "string" || !text.trim() || text.length > 5000 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId || "")) throw new HttpError(400, "請輸入 1～5000 字的回覆。");
        if (!account.accessToken) throw new HttpError(409, "請先更新 OA 連線憑證，啟用網頁回覆。");
        const token = unseal(account.accessToken, getKey(), `${account.channelId}:access-token`);
        const operation = await store.prepareReply(account.channelId, messages[1], operationId, text, now());
        if (!operation.claimed) return res.status(["sent", "failed"].includes(operation.status) ? 200 : 202).json({ message: operation.message });
        let state = "uncertain", note = "傳送結果尚未確認，請用這則訊息的重試按鈕確認，避免另發一則。";
        try {
          const response = await fetchLine("https://api.line.me/v2/bot/message/push", {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Line-Retry-Key": operation.retryKey },
            body: JSON.stringify({ to: operation.to, messages: [{ type: "text", text: operation.text }] }), signal: AbortSignal.timeout(12000),
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
      if (!(error instanceof HttpError)) console.error("BotNest request failed", { code: String(error.code || error.name || "unknown").slice(0, 80) });
      return res.status(error instanceof HttpError ? error.status : 503).json({ error: error instanceof HttpError ? error.message : "服務暫時無法使用，請稍後重試。" });
    }
  };
}
