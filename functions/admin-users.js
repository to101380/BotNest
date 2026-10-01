import { randomUUID } from "node:crypto";
import { canMonitor, MONITOR_GOOGLE_ID } from "./security-monitor.js";
import { usageMonth } from "./ai-usage.js";
const fail = (status, message) => Object.assign(new Error(message), { status });
const protectedUser = user => user.providerData?.some(p => p.providerId === "google.com" && p.uid === MONITOR_GOOGLE_ID);
const totalFields = ["requests", "completed", "failed", "pending", "images", "audioMs", "inputTokens", "outputTokens", "nanoUsd", "unknownCost"];
export function publicAdminUser(user, data = {}) {
  const totals = Object.fromEntries(totalFields.map(key => [key, Object.values(data.usage?.buckets || {}).reduce((sum, bucket) => sum + (Number(bucket[key]) || 0), 0)]));
  const access = data.account?.access || {};
  return { uid: user.uid, email: user.email || "", name: data.account?.profileName || user.displayName || "未命名用戶", emailVerified: !!user.emailVerified,
    providers: (user.providerData || []).map(p => p.providerId), registrationMethod: null,
    createdAt: user.metadata?.creationTime || null, lastSignInAt: user.metadata?.lastSignInTime || null,
    disabled: !!user.disabled || access.disabled === true, authDisabled: !!user.disabled, revision: access.revision || 0,
    syncError: !!access.syncError, pending: !!access.pending, desiredDisabled: access.desiredDisabled, protected: protectedUser(user),
    platforms: [data.channel?.ownerUid === user.uid ? { provider: "LINE", name: data.channel.displayName || data.account.channelId } : null,
      ...["facebook", "instagram"].map(provider => { const value = data.account?.zernio?.[provider]; return value?.accountId ? { provider: provider === "facebook" ? "Messenger" : "Instagram", name: value.displayName || value.name || value.username || value.accountId } : null; })].filter(Boolean),
    plan: null, usage: totals, usageRecorded: !!data.usage?.firstAt };
}

export function createAdminUsers({ auth, store, authorizeSession = async () => {}, now = Date.now }) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
    try {
      let actor; try { const token = /^Bearer (\S+)$/.exec(req.get("authorization") || "")?.[1]; if (token) actor = await auth.verifyIdToken(token, true); } catch {}
      if (!canMonitor(actor)) throw fail(403, "僅限指定的 Google 管理者帳號。");
      await authorizeSession(req, actor);
      const url = new URL(req.originalUrl || req.url, "https://botnest.invalid");
      if (url.pathname === "/api/ai/admin/users" && req.method === "GET") {
        const cursor = url.searchParams.get("cursor") || undefined, month = url.searchParams.get("month") || usageMonth(now());
        if (cursor?.length > 4096 || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw fail(400, "分頁或月份格式錯誤。");
        const page = await auth.listUsers(25, cursor), data = await store.readUsers(page.users.map(u => u.uid), month);
        return res.json({ items: page.users.map(u => publicAdminUser(u, data.get(u.uid))), next: page.pageToken || null, month, updatedAt: now() });
      }
      if (url.pathname !== "/api/ai/admin/access" || req.method !== "PUT") throw fail(405, "不支援此操作。");
      if (!["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(req.get("origin"))) throw fail(403, "請從正式管理頁操作。");
      if (req.rawBody?.length > 4096) throw fail(413, "內容過大。");
      const { uid, disabled, revision } = req.body || {};
      if (typeof uid !== "string" || !uid || uid.length > 128 || /[/\u0000-\u001f]/.test(uid) || typeof disabled !== "boolean" || !Number.isSafeInteger(revision) || revision < 0) throw fail(400, "帳號操作格式錯誤。");
      if (!Number.isFinite(actor.auth_time) || now() / 1000 - actor.auth_time > 600) throw fail(403, "操作前請重新使用 Google 驗證管理者身分（10 分鐘內）。");
      const target = await auth.getUser(uid);
      if (uid === actor.uid || protectedUser(target)) throw fail(403, "不可停用或修改管理者帳號。");
      const operation = randomUUID();
      await store.beginAccess(uid, { operation, actor: actor.uid, disabled, revision, at: now() });
      try {
        // Block application access before touching Auth; failures remain closed.
        await auth.updateUser(uid, { disabled });
        if (disabled) await auth.revokeRefreshTokens(uid);
        await store.finishAccess(uid, operation, disabled, false, now());
      } catch {
        await store.finishAccess(uid, operation, true, true, now());
        throw fail(503, "帳號已暫停網站與 AI 使用，但登入狀態同步未完成。請重新整理後重試。");
      }
      return res.json({ ok: true, disabled });
    } catch (error) {
      const status = error.status || (error.code === "auth/user-not-found" ? 404 : 503);
      return res.status(status).json({ error: error.status ? error.message : status === 404 ? "帳號不存在。" : "管理服務暫時無法完成操作，請重新整理。" });
    }
  };
}

export function createAdminStore(db) {
  const state = db.collection("botnest").doc("state"), accounts = state.collection("accounts");
  return {
    async readUsers(ids, month) {
      const result = new Map(); if (!ids.length) return result;
      const docs = await db.getAll(...ids.flatMap(uid => [accounts.doc(uid), accounts.doc(uid).collection("aiUsageMonths").doc(month)]));
      ids.forEach((uid, i) => result.set(uid, { account: docs[i * 2].data() || {}, usage: docs[i * 2 + 1].data() || {} }));
      const channelIds = [...new Set([...result.values()].map(v => v.account.channelId).filter(Boolean))];
      const channels = channelIds.length ? await db.getAll(...channelIds.map(id => state.collection("channels").doc(id))) : [];
      const channelMap = new Map(channels.map(d => [d.id, d.data()]));
      for (const value of result.values()) value.channel = channelMap.get(value.account.channelId);
      return result;
    },
    async beginAccess(uid, value) {
      const ref = accounts.doc(uid);
      await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data()?.access || {};
        if ((current.revision || 0) !== value.revision || current.pending && value.at - current.updatedAt < 60000) throw fail(409, "帳號狀態已變更或正在處理，請重新整理後再操作。");
        const access = { disabled: true, desiredDisabled: value.disabled, pending: value.operation, revision: value.revision + 1, updatedAt: value.at, actor: value.actor, syncError: false };
        tx.set(ref, { access }, { merge: true });
        tx.set(state.collection("adminAudit").doc(value.operation), { ...value, uid, status: "pending" });
      });
    },
    async finishAccess(uid, operation, disabled, syncError, at) {
      const ref = accounts.doc(uid);
      await db.runTransaction(async tx => {
        const access = (await tx.get(ref)).data()?.access;
        if (access?.pending !== operation) throw fail(409, "帳號操作狀態已變更。");
        tx.set(ref, { access: { ...access, disabled, pending: null, syncError, updatedAt: at } }, { merge: true });
        tx.set(state.collection("adminAudit").doc(operation), { status: syncError ? "failed" : "completed", completedAt: at }, { merge: true });
      });
    },
  };
}
