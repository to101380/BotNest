import { createHash, randomUUID } from "node:crypto";
import { aiError, normalizeAiSettings, validateAiSettings, aiEligibility } from "./ai-policy.js";
import { cleanKnowledge, importFile, importUrl } from "./knowledge.js";
import { generateAnswer } from "./ai-engine.js";
const hash = value => createHash("sha256").update(value).digest("hex");
const docId = /^[a-f0-9-]{36}$/;
export async function handleAiApi({ user, path, req, res, store, getOpenAiKey, openAiConfigured, fetchOpenAi, zernioRequest, now }) {
  const uid = user.uid, query = new URL(req.originalUrl || req.url, "https://botnest.invalid").searchParams;
  if (!["GET", "HEAD"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin && !["https://planning-with-ai-52d58.web.app", "https://planning-with-ai-52d58.firebaseapp.com"].includes(origin)) throw aiError(403, "請從正式網站更新 AI 客服。");
  }
  if (path === "/api/ai/settings") {
    const previous = await store.accountAiSettings(uid);
    if (req.method === "GET") {
      const [line, zernio] = await Promise.all([store.account(uid), store.zernioAccount(uid)]);
      return res.json({ settings: { ...normalizeAiSettings(previous), configured: openAiConfigured() }, connections: { line: !!line, facebook: !!zernio?.facebook, instagram: !!zernio?.instagram } });
    }
    if (req.method === "PUT") {
      const settings = validateAiSettings(req.body, previous);
      if (settings.enabled && !openAiConfigured()) throw aiError(409, "請先在 Firebase 設定 OpenAI API Key。");
      return res.json({ settings: { ...await store.saveAccountAiSettings(uid, settings, now()), configured: openAiConfigured() } });
    }
  }
  if (path === "/api/ai/knowledge" && req.method === "GET") return res.json({ items: await store.aiKnowledge(uid) });
  if (path === "/api/ai/knowledge/import" && req.method === "POST") {
    await store.aiAttempt(uid, "import", now(), 5);
    const item = req.body?.kind === "url" ? await importUrl(req.body.url) : await importFile(req.body, { getOpenAiKey, fetchOpenAi });
    return res.json({ item: await store.saveAiKnowledge(uid, randomUUID(), item, now()) });
  }
  if (path === "/api/ai/knowledge" && req.method === "POST") {
    if (req.body?.draftId !== undefined && (typeof req.body.draftId !== "string" || !docId.test(req.body.draftId))) throw aiError(400, "草稿識別碼無效。");
    await store.aiAttempt(uid, "knowledge", now());
    // A lost create response can be retried without duplicating a draft or
    // overwriting an existing document. IDs remain scoped to the signed-in user.
    return res.json({ item: await store.saveAiKnowledge(uid, req.body.draftId || randomUUID(), { ...cleanKnowledge(req.body), kind: "text", url: "" }, now(), { createOnly: true }) });
  }
  const knowledgeId = /^\/api\/ai\/knowledge\/([a-f0-9-]{36})$/.exec(path)?.[1];
  if (knowledgeId) {
    if (!(await store.aiKnowledge(uid)).some(item => item.id === knowledgeId)) throw aiError(404, "找不到這筆知識。");
    if (req.method === "PUT") return res.json({ item: await store.saveAiKnowledge(uid, knowledgeId, cleanKnowledge(req.body), now()) });
    if (req.method === "DELETE") { await store.deleteAiKnowledge(uid, knowledgeId, now()); return res.json({ ok: true }); }
  }
  if (path === "/api/ai/test" && req.method === "POST") {
    const { question, history = [], provider = "line" } = req.body || {};
    if (typeof question !== "string" || !question.trim() || question.length > 2000 || !["line", "facebook", "instagram"].includes(provider) || !Array.isArray(history) || history.length > 14 || history.some(item => !["user", "assistant"].includes(item?.role) || typeof item.content !== "string" || item.content.length > 2000)) throw aiError(400, "測試內容格式錯誤，問題最多 2,000 字。");
    await store.aiAttempt(uid, "test", now(), 10);
    const settings = normalizeAiSettings(await store.accountAiSettings(uid)), policy = aiEligibility(settings, provider, {}, now(), { preview: true });
    const id = randomUUID(), base = { provider, question: question.trim(), test: true, createdAt: now(), conversationId: "", remoteId: "" };
    if (!policy.allowed) { const result = { action: "skipped", text: "", reason: policy.reason, sources: [] }; await store.saveAiLog(uid, id, { ...base, result, status: "skipped", reason: result.reason }); return res.json({ result, liveEnabled: settings.enabled }); }
    try {
      const result = await generateAnswer({ settings, knowledge: await store.aiKnowledge(uid), history: [...history, { role: "user", content: question.trim() }], getOpenAiKey, fetchOpenAi });
      await store.saveAiLog(uid, id, { ...base, result, status: result.action === "handoff" ? "handoff" : "test", reason: result.reason });
      return res.json({ result, liveEnabled: settings.enabled });
    } catch (error) { await store.saveAiLog(uid, id, { ...base, status: "failed", reason: "AI 測試未完成，請稍後再試。" }); throw error; }
  }
  if (path === "/api/ai/logs" && req.method === "GET") {
    const before = query.get("before"); if (before && !docId.test(before)) throw aiError(400, "分頁參數錯誤。");
    return res.json(await store.aiLogs(uid, before));
  }
  if (path === "/api/ai/conversation") {
    const input = req.method === "GET" ? Object.fromEntries(query) : req.body || {}, { provider, conversationId } = input;
    if (!["line", "facebook", "instagram"].includes(provider) || typeof conversationId !== "string" || !conversationId || conversationId.length > 512 || /[\u0000-\u001f]/.test(conversationId)) throw aiError(400, "對話參數無效。");
    let id;
    if (provider === "line") {
      const line = await store.account(uid);
      if (!line || !/^[a-f0-9]{64}$/.test(conversationId) || !await store.getConversation(line.channelId, conversationId)) throw aiError(404, "找不到這段對話。");
      id = conversationId;
    } else {
      const facebook = (await store.zernioAccount(uid))?.[provider];
      if (!facebook) throw aiError(404, "尚未連接此社群渠道。");
      // Zernio verifies the remote conversation belongs to the connected page before control can be changed.
      if (req.method === "PUT") await zernioRequest(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages?accountId=${encodeURIComponent(facebook.accountId)}&limit=1`);
      id = hash(`${facebook.accountId}:${conversationId}`);
    }
    let control = await store.aiControl(uid, provider, id);
    if (req.method === "PUT") {
      if (!["auto", "human", "off"].includes(input.mode) || !Number.isInteger(input.revision) || input.revision < 0) throw aiError(400, "對話模式格式錯誤。");
      control = await store.setAiControl(uid, provider, id, { mode: input.mode, pausedUntil: 0, reason: input.mode === "human" ? "真人客服處理中" : input.mode === "off" ? "這位顧客已關閉 AI" : "" }, now(), input.revision);
    } else if (req.method !== "GET") throw aiError(405, "不支援的操作。");
    return res.json({ control, state: aiEligibility(await store.accountAiSettings(uid), provider, control, now()) });
  }
  throw aiError(404, "找不到 AI API。");
}
