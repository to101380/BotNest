import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const MINUTE = 60000, DAY = 86400000, TRUST = 30 * DAY, SESSION = 7 * DAY;
export const LOGIN_ORIGIN = "https://planning-with-ai-52d58.web.app";
const ORIGINS = new Set([LOGIN_ORIGIN, "https://planning-with-ai-52d58.firebaseapp.com"]);
const hash = value => createHash("sha256").update(value).digest("hex");
export class LoginSecurityError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new LoginSecurityError(status, message); };
function cookie(req) {
  const matches = String(req.get("cookie") || "").split(";").map(s => s.trim()).filter(s => s.startsWith("__session="));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(10);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function identity(user, at) {
  if (!user?.uid || user.uid.length > 128 || /[/\u0000-\u001f]/.test(user.uid) || !["google.com", "password"].includes(user.firebase?.sign_in_provider)) fail(403, "請使用正式帳號登入。");
  if (user.email_verified !== true || typeof user.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || user.email.length > 254) fail(403, "請先完成帳號 Email 驗證，再更新驗證狀態。");
  if (!Number.isSafeInteger(user.auth_time) || user.auth_time > at / 1000 + 60 || at - user.auth_time * 1000 > SESSION) fail(401, "登入已逾期，請登出後重新登入。");
}
function context(req) {
  const agent = String(req.get("user-agent") || "").slice(0, 512);
  const os = /Android/i.test(agent) ? "Android" : /iPhone|iPad/i.test(agent) ? "iOS" : /Windows/i.test(agent) ? "Windows" : /Macintosh/i.test(agent) ? "macOS" : /Linux/i.test(agent) ? "Linux" : "未知系統";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\/|CriOS\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "未知瀏覽器";
  // Network address is advisory only: never trust it for authorization or infer a city.
  const ip = String(req.ip || "");
  const network = isIP(ip) === 4 ? `${ip.split('.').slice(0, 3).join('.')}.*` : isIP(ip) === 6 ? `${ip.split(':').slice(0, 3).join(':')}:…` : "無法取得";
  return { label: `${os} · ${browser}`, agentFamily: `${os}/${browser}`, network };
}
const empty = () => ({ devices: [], events: [], mailTimes: [] });
function event(state, type, device, at) {
  state.events = [{ id: randomUUID(), type, at, deviceId: device.id, label: device.label, network: device.network }, ...state.events].filter(row => at - row.at < 90 * DAY).slice(0, 100);
}
function active(device, user, at) {
  return device && device.status === "active" && device.email === user.email && device.authTime === user.auth_time && device.trustedUntil > at && device.sessionUntil > at;
}
function own(state, user, req, at) {
  identity(user, at);
  const secret = cookie(req), device = secret && state.devices.find(row => row.key === hash(secret));
  if (!active(device, user, at)) fail(403, "此裝置尚未核准、已逾期或已登出，請回個人資訊完成驗證。");
  return device;
}
const summary = (device, at) => ({ state: device.status === "pending" && device.challenge.expiresAt <= at ? "expired" : device.status,
  access: device.status === "active" && device.sessionUntil > at && device.trustedUntil > at,
  deviceId: device.id, mailState: device.mailState || null, expiresAt: device.challenge?.expiresAt || null });

// One bounded document per account. Every state transition uses a transaction;
// no network calls occur inside retryable Firestore transactions.
export function createLoginSecurityStore(db) {
  const ref = uid => db.collection("botnest").doc("state").collection("accounts").doc(uid).collection("security").doc("login");
  return {
    async read(uid) { return (await ref(uid).get()).data() || empty(); },
    async change(uid, mutate) {
      return db.runTransaction(async tx => {
        const document = ref(uid), state = (await tx.get(document)).data() || empty();
        const result = mutate(state); tx.set(document, state); return result;
      });
    },
  };
}

export function createLoginSecurity({ store, verifyToken, sendMail, mailReady = () => true, now = Date.now }) {
  async function userFor(req) {
    const token = /^Bearer (\S+)$/.exec(req.get("authorization") || "")?.[1];
    let user;
    try { if (token) user = await verifyToken(token); } catch { /* Return a generic error. */ }
    if (!user) fail(401, "登入已失效，請重新登入。");
    identity(user, now()); req.securityUid = user.uid; return user;
  }
  async function authorize(req, user) {
    identity(user, now());
    const state = await store.read(user.uid), device = own(state, user, req, now());
    // Cap heartbeat writes while still checking revocation on every request.
    if (now() - device.lastSeenAt > 5 * MINUTE) await store.change(user.uid, latest => { const current = own(latest, user, req, now()); current.lastSeenAt = now(); });
  }
  async function begin(req, res, user) {
    const at = now(); let secret = cookie(req);
    if (!secret) {
      secret = randomBytes(32).toString("base64url");
      res.set("Set-Cookie", `__session=${secret}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`);
    }
    const key = hash(secret), details = context(req), proof = randomBytes(32).toString("base64url");
    const result = await store.change(user.uid, state => {
      let device = state.devices.find(row => row.key === key);
      if (device?.email === user.email && device.authTime === user.auth_time) {
        if (active(device, user, at)) return { response: summary(device, at) };
        if (["denied", "revoked"].includes(device.status)) fail(403, "此登入已遭拒絕或登出，請重新登入。");
        if (device.status === "pending" && device.challenge.expiresAt > at && (device.mailState === "sent" || (device.mailState === "sending" && at - device.lastSeenAt < MINUTE))) return { response: summary(device, at) };
      }
      if (at - user.auth_time * 1000 > 10 * MINUTE) fail(401, "請先登出並重新登入，再驗證此裝置。");
      if (device && user.auth_time < device.authTime) fail(401, "此登入已被較新的登入取代，請重新登入。");
      const trusted = device?.status === "active" && device.email === user.email && device.trustedUntil > at && device.agentFamily === details.agentFamily;
      if (!trusted) {
        if (!mailReady()) fail(503, "安全驗證寄信服務尚未就緒，請聯絡管理者。");
        state.mailTimes = state.mailTimes.filter(t => at - t < 60 * MINUTE);
        if (state.mailTimes.length >= 3 || state.mailTimes.some(t => at - t < MINUTE)) fail(429, "安全驗證信寄送過於頻繁，請稍後再試（每小時最多 3 封）。");
        state.mailTimes.push(at);
      }
      const previousTrust = device?.trustedUntil || 0;
      if (!device) {
        // Never evict an active device just because a requester creates many pending ones.
        state.devices = state.devices.filter(row => row.trustedUntil > at || row.challenge?.expiresAt > at || at - row.lastSeenAt < DAY);
        if (state.devices.length >= 30) fail(429, "登入裝置數已達上限，請從已核准裝置移除舊裝置。");
        device = { id: randomUUID(), key, createdAt: at }; state.devices.push(device);
      }
      Object.assign(device, details, { email: user.email, authTime: user.auth_time, lastSeenAt: at, sessionUntil: Math.min(at + SESSION, user.auth_time * 1000 + SESSION),
        status: trusted ? "active" : "pending", trustedUntil: trusted ? previousTrust : 0, mailState: trusted ? null : "sending" });
      if (trusted) {
        delete device.challenge; event(state, "login", device, at); return { response: summary(device, at) };
      }
      device.challenge = { id: randomUUID(), proofHash: hash(proof), expiresAt: at + 15 * MINUTE };
      event(state, "approval_requested", device, at);
      return { response: summary(device, at), mail: { deviceId: device.id, challengeId: device.challenge.id, label: device.label, network: device.network } };
    });
    if (result.mail) {
      const ticket = `${Buffer.from(user.uid).toString("base64url")}.${result.mail.challengeId}.${proof}`;
      let sent = false;
      try {
        await sendMail({ to: user.email, url: `${LOGIN_ORIGIN}/login-approval.html#${ticket}`, id: result.mail.challengeId, ...result.mail, at }); sent = true;
      } catch { /* Never log the link, mail address, credentials or provider response. */ }
      result.response.mailState = sent ? "sent" : "failed";
      await store.change(user.uid, state => {
        const device = state.devices.find(row => row.id === result.mail.deviceId);
        if (device?.challenge?.id === result.mail.challengeId && device.status === "pending") {
          device.mailState = sent ? "sent" : "failed";
          event(state, sent ? "mail_sent" : "mail_failed", device, now());
        }
      });
    }
    return res.json(result.response);
  }
  function parseTicket(value) {
    if (typeof value !== "string" || value.length > 300) fail(400, "驗證連結無效或已失效。");
    const parts = /^([A-Za-z0-9_-]{2,172})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!parts) fail(400, "驗證連結無效或已失效。");
    const uid = Buffer.from(parts[1], "base64url").toString("utf8");
    if (!uid || uid.length > 128 || /[/\u0000-\u001f]/.test(uid) || Buffer.from(uid).toString("base64url") !== parts[1]) fail(400, "驗證連結無效或已失效。");
    return { uid, id: parts[2], proofHash: hash(parts[3]) };
  }
  function ticketDevice(state, ticket) {
    const device = state.devices.find(row => row.challenge?.id === ticket.id);
    if (!device || device.status !== "pending" || device.challenge.expiresAt <= now() || !timingSafeEqual(Buffer.from(device.challenge.proofHash), Buffer.from(ticket.proofHash))) fail(410, "驗證連結已使用、過期或失效，請回原登入裝置重新申請。");
    return device;
  }
  async function handle(req, res) {
    res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
    try {
      const path = new URL(req.originalUrl || req.url, LOGIN_ORIGIN).pathname;
      if (req.method !== "GET" && req.method !== "POST") fail(405, "不支援此操作。");
      if (req.method === "POST" && (!ORIGINS.has(req.get("origin")) || !/^application\/json(?:;|$)/i.test(req.get("content-type") || ""))) fail(403, "請從正式網站操作。");
      if (path === "/api/login-security/review" || path === "/api/login-security/decision") {
        if (req.method !== "POST") fail(405, "請在驗證頁面確認操作。");
        const ticket = parseTicket(req.body?.ticket);
        if (path.endsWith("/review")) {
          const device = ticketDevice(await store.read(ticket.uid), ticket);
          return res.json({ label: device.label, network: device.network, at: device.lastSeenAt, expiresAt: device.challenge.expiresAt });
        }
        if (!["approve", "deny"].includes(req.body?.decision)) fail(400, "請選擇核准或拒絕。");
        await store.change(ticket.uid, state => {
          const device = ticketDevice(state, ticket), approved = req.body.decision === "approve";
          device.status = approved ? "active" : "denied"; device.trustedUntil = approved ? now() + TRUST : 0;
          delete device.challenge; event(state, approved ? "approved" : "denied", device, now());
        });
        return res.json({ ok: true });
      }
      const user = await userFor(req);
      if (path === "/api/login-security/session") {
        if (req.method === "POST") return await begin(req, res, user);
        const secret = cookie(req), state = await store.read(user.uid), device = secret && state.devices.find(row => row.key === hash(secret) && row.authTime === user.auth_time && row.email === user.email);
        return res.json(device ? summary(device, now()) : { state: "missing", access: false });
      }
      if (path === "/api/login-security/overview" && req.method === "GET") {
        const state = await store.read(user.uid), current = own(state, user, req, now());
        return res.json({ devices: state.devices.filter(d => d.trustedUntil > now() || d.challenge?.expiresAt > now()).map(d => ({ id: d.id, label: d.label, network: d.network, current: d.id === current.id,
          state: d.status, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt, trustedUntil: d.trustedUntil })), events: state.events.filter(e => now() - e.at < 90 * DAY), now: now() });
      }
      if (path === "/api/login-security/revoke" && req.method === "POST") {
        const target = req.body?.deviceId;
        if (target !== "others" && !/^[a-f0-9-]{36}$/.test(target || "")) fail(400, "裝置格式錯誤。");
        await store.change(user.uid, state => {
          const current = own(state, user, req, now());
          const devices = state.devices.filter(d => target === "others" ? d.id !== current.id : d.id === target);
          if (target !== "others" && !devices.length) fail(404, "找不到此帳號的裝置。");
          for (const device of devices) {
            device.status = "revoked"; device.trustedUntil = 0; delete device.challenge;
            event(state, "revoked", device, now());
          }
        });
        return res.json({ ok: true });
      }
      fail(404, "找不到登入安全功能。");
    } catch (error) {
      return res.status(error instanceof LoginSecurityError ? error.status : 503).json({ error: error instanceof LoginSecurityError ? error.message : "登入安全服務暫時無法使用，請稍後再試。" });
    }
  }
  return { authorize, handle };
}

export function createLoginMailer({ config, fetchMail = fetch }) {
  return async ({ to, url, id, label, network, at }) => {
    const { apiKey, from } = config();
    if (!apiKey || !from || /[\r\n]/.test(from)) throw new Error("mail-unconfigured");
    const response = await fetchMail("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `login-${id}` },
      body: JSON.stringify({ from, to: [to], subject: "BotNest：請確認新裝置登入", text: `有人使用你的帳號申請登入 BotNest。\n時間：${new Date(at).toISOString()}\n裝置：${label}\n網路（部分隱藏）：${network}\n\n尚未授權存取帳號資料。若是你本人操作，請在 15 分鐘內開啟下方頁面並選擇「這是我，核准登入」。若不是你，請選擇「不是我，拒絕登入」，並從原本的登入服務修改密碼。\n\n${url}\n\n不確定時請勿核准。裝置資訊僅供參考；清除 Cookie 或使用無痕模式會視為新裝置。` }) });
    if (!response.ok) throw new Error("mail-unavailable");
  };
}
