import { createHash } from "node:crypto";
const fail = (status, message) => Object.assign(new Error(message), { status });
export function cleanWorkflow(body, uid) {
  if (body && ["pin", "unread", "read"].includes(body.action)) {
    if (typeof body.id !== "string" || !body.id || body.id.length > 512 || /[\u0000-\u001f]/.test(body.id) || typeof body.value !== "boolean" || !Number.isSafeInteger(body.revision) || body.revision < 0 || Object.keys(body).some(k => !["id", "action", "value", "revision", "messageId"].includes(k)) || typeof body.messageId !== "string" || !body.messageId || body.messageId.length > 256 || /[\u0000-\u001f]/.test(body.messageId)) throw fail(400, "訊息操作格式錯誤。");
    return { id: body.id, revision: body.revision, action: body.action, value: body.value, messageId: body.messageId, patch: {} };
  }
  if (!body || typeof body.id !== "string" || !body.id || body.id.length > 512 || /[\u0000-\u001f]/.test(body.id) || !["follow", "trash", "complete", "assign"].includes(body.action) || typeof body.value !== "boolean" || !Number.isSafeInteger(body.revision) || body.revision < 0 || Object.keys(body).some(k => !["id", "action", "value", "revision"].includes(k))) throw fail(400, "對話操作格式錯誤。");
  return { id: body.id, revision: body.revision, patch: { [({ follow: "followed", trash: "trashed", complete: "completed", assign: "assignee" })[body.action]]: body.action === "assign" ? body.value ? uid : null : body.value } };
}
export function workflowRef(account, id) {
  return account.collection("conversationWorkflow").doc(createHash("sha256").update(id).digest("hex"));
}
export function reopenedWorkflow(prior, sentAt, at = Date.now()) {
  if (!prior || !Number.isFinite(sentAt)) return null;
  const completed = prior.completed && sentAt > (prior.completedAt ?? prior.updatedAt);
  const trashed = prior.trashed && sentAt > (prior.trashedAt ?? prior.updatedAt);
  const purged = prior.purgedAt && sentAt > prior.purgedAt;
  if (!completed && !trashed && !purged) return null;
  return { ...prior, completed: false, trashed: false, purging: false, lastPurgedAt: prior.purgedAt || prior.purgeBefore || prior.lastPurgedAt || 0, purgedAt: purged ? 0 : prior.purgedAt || 0, revision: prior.revision + 1, updatedAt: at };
}
export function createWorkflowStore(db) {
  const collection = uid => db.collection("botnest").doc("state").collection("accounts").doc(uid).collection("conversationWorkflow");
  return {
    async list(uid) { return (await collection(uid).orderBy("updatedAt", "desc").limit(1000).get()).docs.map(doc => doc.data()); },
    async save(uid, value, at) {
      const ref = collection(uid).doc(createHash("sha256").update(value.id).digest("hex"));
      return db.runTransaction(async tx => {
        const prior = (await tx.get(ref)).data() || { id: value.id, followed: false, trashed: false, completed: false, assignee: null, revision: 0 };
        if (prior.purging) throw fail(409, "這段對話正在永久清除，暫時無法還原。");
        if (prior.revision !== value.revision) throw fail(409, "對話狀態已更新，請重新操作。");
        if (value.action === "pin") {
          const pinned = (prior.pinnedMessages || []).filter(id => id !== value.messageId);
          if (value.value) { if (pinned.length >= 20) throw fail(400, "每段對話最多釘選 20 則訊息。"); pinned.push(value.messageId); }
          value.patch = { pinnedMessages: pinned };
        }
        if (value.action === "unread") value.patch = { unreadMessageId: value.messageId, unreadAt: at };
        if (value.action === "read") value.patch = { unreadMessageId: "", unreadAt: 0 };
        const result = { ...prior, ...value.patch, ...(value.patch.completed === true ? { completedAt: at } : {}), ...(value.patch.trashed === true ? { trashedAt: at } : {}), ...(value.patch.trashed === false ? { purgeBefore: 0 } : {}), revision: prior.revision + 1, updatedAt: at }; tx.set(ref, result); return result;
      });
    },
  };
}
export function createWorkflowHandler({ db, verifyToken, authorizeSession = async () => {}, accountStore, now = Date.now }) {
  const store = createWorkflowStore(db);
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const token = /^Bearer (\S+)$/.exec(req.get("authorization") || "")?.[1]; let user;
      try { if (token) user = await verifyToken(token); } catch {}
      if (!user?.uid) throw fail(401, "請先登入。");
      if (!["google.com", "password"].includes(user.firebase?.sign_in_provider) || user.firebase.sign_in_provider === "password" && !user.email_verified) throw fail(403, "請先驗證帳號。");
      await authorizeSession(req, user);
      if (await accountStore.isAccountDisabled(user.uid)) throw fail(403, "帳號已停用。");
      await accountStore.aiAttempt(user.uid, "api", now(), 120);
      if (req.method === "GET") return res.json({ items: await store.list(user.uid), retention: (await db.collection("botnest").doc("state").collection("accounts").doc(user.uid).collection("retention").doc("settings").get()).data() || null });
      if (req.method !== "PUT") throw fail(405, "不支援此操作。");
      if (!["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(req.get("origin"))) throw fail(403, "請從正式網站操作。");
      const value = cleanWorkflow(req.body, user.uid); await accountStore.aiAttempt(user.uid, "workflow", now(), 30);
      return res.json({ item: await store.save(user.uid, value, now()) });
    } catch (e) { return res.status(e.status || 503).json({ error: e.status ? e.message : "對話狀態暫時無法更新。" }); }
  };
}
