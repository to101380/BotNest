import { createHash } from "node:crypto";
import { unseal } from "./core.js";
import { generateAnswer } from "./ai-engine.js";
import { aiEligibility, normalizeAiSettings } from "./ai-policy.js";

function operationId(value) {
  const hash = createHash("sha256").update(`openai:${value}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function splitReply(text) {
  if (text.length <= 80) return [text];
  // Keep multiline lists, steps and URLs intact. Split prose only at sentence boundaries.
  const blocks = text.split(/\n\s*\n/).filter(Boolean);
  const units = blocks.flatMap(block => /https?:\/\/|(?:^|\n)\s*(?:[-*•①②③]|\d+[.)、])/.test(block) ? [block] : block.split(/(?<=[。！？!?])\s*/u).filter(Boolean));
  const parts = [];
  for (const unit of units) {
    if (parts.length && parts[parts.length - 1].length < 30) parts[parts.length - 1] += "\n" + unit;
    else parts.push(unit);
  }
  return parts.length > 3 ? [...parts.slice(0, 2), parts.slice(2).join("\n\n")] : parts;
}
async function respond({ store, uid, provider, conversationId, messageId, message, claim, finish, history, send, typing, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), getOpenAiKey, fetchOpenAi, now }) {
  if (!message || message.direction !== "incoming" || message.type !== "text" || message.unsent || !message.text?.trim()) return { skipped: true };
  const id = operationId(`${uid}:${provider}:${conversationId}:${messageId}`);
  const [settings, control, prior] = await Promise.all([store.accountAiSettings(uid), store.aiControl(uid, provider, conversationId), store.aiLog(uid, id)]);
  if (prior && ["sent", "handoff", "skipped", "failed"].includes(prior.status)) return { skipped: true };
  const ai = normalizeAiSettings(settings), eligibility = aiEligibility(ai, provider, control, now());
  const base = { provider, conversationId, remoteId: message.remoteConversationId || "", messageId, question: message.text.slice(0, 2000), createdAt: prior?.createdAt || now(), test: false };
  if (!eligibility.allowed || !getOpenAiKey()) {
    await store.saveAiLog(uid, id, { ...base, status: "skipped", reason: eligibility.allowed ? "OpenAI 金鑰尚未設定" : eligibility.reason });
    await finish("skipped"); return { skipped: true };
  }
  if (!await claim()) {
    const current = provider === "line" ? await store.getMessage(message.channelId, conversationId, messageId) : await store.getZernioMessage(uid, conversationId, messageId);
    if (current?.aiStatus === "throttled") await store.saveAiLog(uid, id, { ...base, status: "skipped", reason: "已達 AI 回覆頻率或每日用量上限，請由真人回覆。" });
    return { skipped: true };
  }
  try {
    // Cosmetic, bounded and best-effort; only after eligibility and the send lease.
    await typing().catch(() => {});
    const result = prior?.result || await generateAnswer({ settings: ai, knowledge: () => store.aiKnowledge(uid), history: await history(), getOpenAiKey, fetchOpenAi });
    await store.saveAiLog(uid, id, { ...base, result, status: "prepared", reason: result.reason });
    // Check policy again after inference in case a human took over while the model was running.
    const [latestSettings, latestControl, liveMessage] = await Promise.all([store.accountAiSettings(uid), store.aiControl(uid, provider, conversationId), provider === "line" ? store.getMessage(message.channelId, conversationId, messageId) : store.getZernioMessage(uid, conversationId, messageId)]);
    const allowed = aiEligibility(latestSettings, provider, latestControl, now());
    if (!allowed.allowed || (latestControl.revision || 0) !== (control.revision || 0) || JSON.stringify(normalizeAiSettings(latestSettings)) !== JSON.stringify(ai) || liveMessage?.unsent) {
      await store.saveAiLog(uid, id, { status: "skipped", reason: allowed.allowed ? "設定或對話已更新，取消這次回覆" : allowed.reason });
      await finish("skipped"); return { skipped: true };
    }
    if (result.action === "handoff") await store.setAiControl(uid, provider, conversationId, { mode: "human", pausedUntil: 0, reason: result.reason }, now(), control.revision || 0);
    const parts = prior?.parts || (provider !== "line" && ai.splitReplies[provider] && result.action !== "handoff" ? splitReply(result.text) : [result.text]);
    let sentParts = prior?.sentParts || 0;
    await store.saveAiLog(uid, id, { parts, sentParts });
    for (let index = sentParts; index < parts.length; index++) {
      if (index > 0) {
        await typing().catch(() => {});
        await wait(Math.min(2000, Math.max(1000, parts[index].length * 30)));
      }
      if (provider !== "line" && result.action !== "handoff") {
        const [settingsNow, controlNow, conversationNow] = await Promise.all([store.accountAiSettings(uid), store.aiControl(uid, provider, conversationId), store.getZernioConversation(uid, conversationId)]);
        if (!aiEligibility(settingsNow, provider, controlNow, now()).allowed || (controlNow.revision || 0) !== (control.revision || 0) || JSON.stringify(normalizeAiSettings(settingsNow)) !== JSON.stringify(ai) || (conversationNow?.latestIncomingId && conversationNow.latestIncomingId !== messageId)) {
          await store.saveAiLog(uid, id, { status: "skipped", reason: "對話或設定已更新，停止剩餘段落", sentParts });
          await finish("skipped"); return { skipped: true };
        }
      }
      await send(parts[index], index === 0 ? id : operationId(`${id}:part:${index}`));
      sentParts = index + 1;
      await store.saveAiLog(uid, id, { sentParts });
    }
    const status = result.action === "handoff" ? "handoff" : "sent";
    await store.saveAiLog(uid, id, { status, completedAt: now() }); await finish(status);
    return status === "sent" ? { sent: true } : { handoff: true };
  } catch (error) {
    const reason = error.status === 409 ? "對話狀態已變更，AI 未傳送" : error.status ? error.message : "AI 或訊息渠道暫時無法完成回覆，請由真人確認並接手。";
    await store.saveAiLog(uid, id, { ...base, status: "failed", reason, completedAt: now() }); await finish("failed");
    throw error;
  }
}
export function createAiResponder({ store, getKey, getOpenAiKey, fetchOpenAi = fetch, fetchLine = fetch, now = Date.now }) {
  return async ({ channelId, conversationId, messageId }) => {
    const channel = await store.getChannel(channelId), message = await store.getMessage(channelId, conversationId, messageId);
    if (!channel?.accessToken || !channel.ownerUid) return { skipped: true };
    return respond({ store, uid: channel.ownerUid, provider: "line", conversationId, messageId, message: message && { ...message, channelId }, now, getOpenAiKey, fetchOpenAi,
      claim: () => store.claimAiReply(channelId, conversationId, messageId, now()), finish: status => store.finishAiReply(channelId, conversationId, messageId, status, now()),
      typing: async () => {
        const target = await store.getConversation(channelId, conversationId);
        if (target?.sourceType !== "user" || !/^U[a-f0-9]{32}$/.test(target.sourceId || "")) return;
        const token = unseal(channel.accessToken, getKey(), `${channelId}:access-token`);
        await fetchLine("https://api.line.me/v2/bot/chat/loading/start", { method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: target.sourceId, loadingSeconds: 30 }), signal: AbortSignal.timeout(1500) });
      },
      history: async () => {
        const items = (await store.recentMessages(channelId, conversationId, 16)).filter(item => !item.unsent && item.type === "text" && item.text?.trim() && item.sentAt <= message.sentAt);
        const result = items.map(item => ({ role: item.direction === "outgoing" ? "assistant" : "user", content: item.text.slice(0, 2000) }));
        if (!items.some(item => item.id === messageId)) result.push({ role: "user", content: message.text.slice(0, 2000) });
        return result;
      },
      send: async (text, replyId) => {
        const operation = await store.prepareReply(channelId, conversationId, replyId, text, now(), null, splitReply(text), messageId);
        if (!operation.claimed) { if (operation.status === "sent") return; throw new Error("line_pending"); }
        const token = unseal(channel.accessToken, getKey(), `${channelId}:access-token`);
        const isReply = operation.deliveryMode === "reply";
        let sent;
        try {
          sent = await fetchLine(`https://api.line.me/v2/bot/message/${isReply ? "reply" : "push"}`, { method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(!isReply ? { "X-Line-Retry-Key": operation.retryKey } : {}) },
            body: JSON.stringify({ ...(isReply ? { replyToken: unseal(operation.replyToken, getKey(), `${channelId}:${messageId}:reply-token`) } : { to: operation.to }), messages: operation.lineMessages }), signal: AbortSignal.timeout(12000) });
        } catch (error) {
          if (isReply) await store.finishReply(channelId, replyId, "failed", "LINE 回覆結果未確認，請先查看 LINE 對話；為避免重複訊息，不自動補送。");
          throw error;
        }
        const accepted = sent.ok || (!isReply && sent.status === 409 && sent.headers.get("x-line-accepted-request-id"));
        await store.finishReply(channelId, replyId, accepted ? "sent" : "failed", accepted ? "" : "AI 回覆傳送失敗，請由真人確認並回覆。");
        if (!accepted) throw new Error(`line_${sent.status}`);
      },
    });
  };
}
export function createZernioAiResponder({ store, getOpenAiKey, getZernioKey, fetchOpenAi = fetch, fetchZernio = fetch, now = Date.now, wait }) {
  return async ({ uid, conversationId, messageId }) => {
    const [message, account] = await Promise.all([store.getZernioMessage(uid, conversationId, messageId), store.zernioAccount(uid)]);
    const provider = message?.provider || "facebook";
    if (!message || !["facebook", "instagram"].includes(provider) || !getZernioKey() || message.accountId !== account?.[provider]?.accountId) return { skipped: true };
    const endpoint = `https://zernio.com/api/v1/inbox/conversations/${encodeURIComponent(message.remoteConversationId)}/messages`, headers = { Authorization: `Bearer ${getZernioKey()}`, "Content-Type": "application/json" };
    return respond({ store, uid, provider, conversationId, messageId, message, now, wait, getOpenAiKey, fetchOpenAi,
      claim: () => store.claimZernioAiReply(uid, conversationId, messageId, now()), finish: status => store.finishZernioAiReply(uid, conversationId, messageId, status, now()),
      typing: async () => {
        await fetchZernio(endpoint.replace(/\/messages$/, "/typing"), { method: "POST", headers,
          body: JSON.stringify({ accountId: message.accountId }), signal: AbortSignal.timeout(1500) });
      },
      history: async () => {
        const response = await fetchZernio(`${endpoint}?accountId=${encodeURIComponent(message.accountId)}&limit=16&sortOrder=desc`, { headers, signal: AbortSignal.timeout(12000) });
        const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`zernio_history_${response.status}`);
        const items = (data.messages || []).filter(item => !item.isDeleted && (!item.accountId || item.accountId === message.accountId) && (!item.conversationId || item.conversationId === message.remoteConversationId) && typeof item.message === "string" && item.message.trim() && (!item.createdAt || Date.parse(item.createdAt) <= message.sentAt)).reverse();
        const result = items.map(item => ({ role: item.direction === "outgoing" ? "assistant" : "user", content: item.message.slice(0, 2000) }));
        if (!items.some(item => [item.id, item.platformMessageId].includes(message.remoteMessageId))) result.push({ role: "user", content: message.text.slice(0, 2000) }); return result;
      },
      send: async (text, replyId) => {
        const sent = await fetchZernio(endpoint, { method: "POST", headers: { ...headers, "Idempotency-Key": replyId }, body: JSON.stringify({ accountId: message.accountId, message: text }), signal: AbortSignal.timeout(15000) });
        if (!sent.ok) throw new Error(`zernio_send_${sent.status}`);
      },
    });
  };
}
