import { createMonitor, aiMetrics } from "./security-monitor.js";
import { HttpError } from "./core.js";
import { createHash, randomUUID } from "node:crypto";
import { normalizeAiSettings } from "./ai-policy.js";

const digestId = value => createHash("sha256").update(String(value)).digest("hex");

export function createStore(db) {
  const monitor = createMonitor(db);
  const state = db.collection("botnest").doc("state");
  const channels = state.collection("channels");
  const accounts = state.collection("accounts");
  const rows = snapshot => snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  async function page(collection, order, before, limit) {
    let query = collection.orderBy(order, "desc");
    if (before) {
      const cursor = await collection.doc(before).get();
      if (!cursor.exists) throw new HttpError(400, "分頁已失效，請重新整理。");
      query = query.startAfter(cursor);
    }
    const result = rows(await query.limit(limit + 1).get());
    return { items: result.slice(0, limit), next: result.length > limit ? result[limit - 1].id : null };
  }
  return {
    async aiKnowledge(uid) {
      return rows(await accounts.doc(uid).collection("aiKnowledge").where("deleted", "==", false).limit(40).get()).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async saveAiKnowledge(uid, id, item, at) {
      const account = accounts.doc(uid), ref = account.collection("aiKnowledge").doc(id), meter = account.collection("limits").doc("knowledge");
      return db.runTransaction(async tx => {
        const [prior, usage] = await tx.getAll(ref, meter), old = prior.data(), current = usage.data() || { count: 0, characters: 0 };
        const count = current.count + (!old || old.deleted ? 1 : 0), characters = current.characters - (old?.content?.length || 0) + item.content.length;
        if (count > 40 || characters > 800000) throw new HttpError(429, "知識庫最多 40 筆、合計 80 萬字。");
        const value = { ...old, ...item, deleted: false, updatedAt: at, createdAt: old?.createdAt || at };
        tx.set(ref, value); tx.set(meter, { count, characters }); return { id, ...value };
      });
    },
    async deleteAiKnowledge(uid, id, at) {
      const account = accounts.doc(uid), ref = account.collection("aiKnowledge").doc(id), meter = account.collection("limits").doc("knowledge");
      await db.runTransaction(async tx => {
        const [prior, usage] = await tx.getAll(ref, meter), old = prior.data(), current = usage.data() || { count: 1, characters: 0 };
        if (!old || old.deleted) throw new HttpError(404, "找不到這筆知識。");
        // Erase the content while retaining only an id tombstone for old log references.
        tx.set(ref, { deleted: true, content: "", enabled: false, updatedAt: at });
        tx.set(meter, { count: Math.max(0, current.count - 1), characters: Math.max(0, current.characters - old.content.length) });
      });
    },
    async aiControl(uid, provider, conversationId) {
      return (await accounts.doc(uid).collection("aiConversations").doc(`${provider}-${conversationId}`).get()).data() || { mode: "auto", pausedUntil: 0, revision: 0 };
    },
    async setAiControl(uid, provider, conversationId, patch, at, expectedRevision) {
      const ref = accounts.doc(uid).collection("aiConversations").doc(`${provider}-${conversationId}`);
      return db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data() || { mode: "auto", pausedUntil: 0, revision: 0 };
        if (expectedRevision != null && (old.revision || 0) !== expectedRevision) throw new HttpError(409, "對話狀態已變更，請重新整理。");
        const value = { ...old, ...patch, updatedAt: at, revision: (old.revision || 0) + 1 };
        tx.set(ref, value); return value;
      });
    },
    async pauseAiForHuman(uid, provider, conversationId, at) {
      const settings = normalizeAiSettings(await this.accountAiSettings(uid));
      const ref = accounts.doc(uid).collection("aiConversations").doc(`${provider}-${conversationId}`);
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data() || { mode: "auto", revision: 0 };
        tx.set(ref, { ...old, pausedUntil: Math.max(old.pausedUntil || 0, at + settings.humanPauseMinutes * 60000), reason: "真人已回覆，AI 暫停中", updatedAt: at, revision: (old.revision || 0) + 1 });
      });
    },
    async aiAttempt(uid, kind, at, maximum = 20) {
      const ref = accounts.doc(uid).collection("limits").doc(`ai-${kind}`);
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data(), active = old && at - old.since < 60000;
        if (active && old.count >= maximum) throw new HttpError(429, "操作過於頻繁，請一分鐘後再試。");
        tx.set(ref, { since: active ? old.since : at, count: active ? old.count + 1 : 1 });
      });
    },
    async aiLog(uid, id) { return (await accounts.doc(uid).collection("aiLogs").doc(id).get()).data(); },
    async saveAiLog(uid, id, value) { await accounts.doc(uid).collection("aiLogs").doc(id).set(value, { merge: true }); await monitor.record(aiMetrics(value)); },
    aiLogs(uid, before) { return page(accounts.doc(uid).collection("aiLogs"), "createdAt", before, 30); },
    async zernioAccount(uid) {
      const value = (await accounts.doc(uid).get()).data();
      return value?.zernio || null;
    },
    async saveZernioProfile(uid, profileId, at) {
      const ref = accounts.doc(uid);
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data() || {};
        const prior = old.zernio || {};
        if (prior.profileId && prior.profileId !== profileId) throw new HttpError(409, "此帳號已建立其他 Zernio Profile。");
        tx.set(ref, { zernio: { ...prior, profileId, updatedAt: at } }, { merge: true });
      });
    },
    async zernioOwner(profileId) {
      const snapshot = await accounts.where("zernio.profileId", "==", profileId).limit(1).get();
      if (snapshot.empty) return null;
      return { uid: snapshot.docs[0].id, zernio: snapshot.docs[0].data().zernio };
    },
    async zernioOwnerByAccount(accountId, platform = "facebook") {
      if (!["facebook", "instagram"].includes(platform)) return null;
      const snapshot = await accounts.where(`zernio.${platform}.accountId`, "==", accountId).limit(1).get();
      if (snapshot.empty) return null;
      return { uid: snapshot.docs[0].id, account: snapshot.docs[0].data() };
    },
    bindZernioFacebook(uid, profileId, account, at) {
      return this.bindZernioPlatform(uid, profileId, "facebook", account, at);
    },
    async bindZernioPlatform(uid, profileId, platform, account, at) {
      if (!["facebook", "instagram"].includes(platform)) throw new HttpError(400, "不支援的渠道。");
      const ref = accounts.doc(uid);
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data() || {}, prior = old.zernio || {};
        if (prior.profileId !== profileId) throw new HttpError(409, "Zernio Profile 與網站帳號不符。");
        if (prior[platform]?.accountId && prior[platform].accountId !== account.accountId) throw new HttpError(409, "此網站帳號已連接此渠道的其他帳號。");
        tx.set(ref, { zernio: { ...prior, [platform]: { ...account, connectedAt: at }, updatedAt: at } }, { merge: true });
      });
    },
    async zernioSendAttempt(uid, at) {
      const ref = accounts.doc(uid).collection("limits").doc("zernioSend");
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data(), active = old && at - old.since < 60000;
        if (active && old.count >= 20) throw new HttpError(429, "Facebook 回覆頻率過高，請一分鐘後再試。");
        tx.set(ref, { since: active ? old.since : at, count: active ? old.count + 1 : 1 });
      });
    },
    async zernioCustomer(uid, conversationId) {
      return (await accounts.doc(uid).collection("zernioCustomers").doc(conversationId).get()).data()?.customer || {};
    },
    async saveZernioCustomer(uid, conversationId, profile, at) {
      const ref = accounts.doc(uid).collection("zernioCustomers").doc(conversationId);
      return db.runTransaction(async tx => {
        const prior = (await tx.get(ref)).data()?.customer || {};
        const customer = { ...profile, notes: Array.isArray(prior.notes) ? prior.notes.slice(0, 30) : [], updatedAt: at };
        tx.set(ref, { customer }, { merge: true });
        return customer;
      });
    },
    async addZernioCustomerNote(uid, conversationId, text, at) {
      const ref = accounts.doc(uid).collection("zernioCustomers").doc(conversationId);
      return db.runTransaction(async tx => {
        const prior = (await tx.get(ref)).data()?.customer || {};
        const notes = [{ id: randomUUID(), text, createdAt: at }, ...(Array.isArray(prior.notes) ? prior.notes : [])].slice(0, 30);
        const customer = { ...prior, notes, updatedAt: at };
        tx.set(ref, { customer }, { merge: true });
        return customer;
      });
    },
    async deleteZernioCustomerNote(uid, conversationId, noteId, at) {
      const ref = accounts.doc(uid).collection("zernioCustomers").doc(conversationId);
      return db.runTransaction(async tx => {
        const prior = (await tx.get(ref)).data()?.customer || {}, oldNotes = Array.isArray(prior.notes) ? prior.notes : [];
        const notes = oldNotes.filter(note => note.id !== noteId);
        if (notes.length === oldNotes.length) throw new HttpError(404, "找不到這則記事。");
        const customer = { ...prior, notes, updatedAt: at };
        tx.set(ref, { customer }, { merge: true });
        return customer;
      });
    },
    async accountAiSettings(uid) {
      const value = (await accounts.doc(uid).get()).data() || {};
      if (value.ai) return value.ai;
      if (!value.channelId) return {};
      return (await channels.doc(value.channelId).get()).data()?.ai || {};
    },
    async saveAccountAiSettings(uid, settings, at) {
      const ref = accounts.doc(uid), value = { ...settings, updatedAt: at };
      await db.runTransaction(async tx => {
        const account = (await tx.get(ref)).data() || {};
        tx.set(ref, { ai: value }, { merge: true });
        if (account.channelId) tx.set(channels.doc(account.channelId), { ai: value }, { merge: true });
      });
      return value;
    },
    async ingestZernio(uid, event) {
      const account = accounts.doc(uid), conversationId = digestId(`${event.accountId}:${event.remoteConversationId}`);
      const conversation = account.collection("zernioConversations").doc(conversationId);
      const messageId = digestId(`${event.accountId}:${event.remoteMessageId}`), message = conversation.collection("messages").doc(messageId);
      const receipt = account.collection("zernioReceipts").doc(digestId(event.eventId));
      let created = false;
      await db.runTransaction(async tx => {
        const [seen, prior, priorMessage] = await tx.getAll(receipt, conversation, message);
        if (seen.exists || priorMessage.exists) return;
        const old = prior.data(), stored = { ...event, id: messageId, conversationId, direction: "incoming", type: event.type || "text", unsent: false };
        tx.set(message, stored);
        if (!old || event.sentAt >= old.updatedAt) tx.set(conversation, { remoteConversationId: event.remoteConversationId, accountId: event.accountId,
          displayName: event.displayName, pictureUrl: event.pictureUrl, lastText: event.text, latestIncomingId: messageId, updatedAt: event.sentAt,
          createdAt: old?.createdAt == null ? event.sentAt : Math.min(old.createdAt, event.sentAt) }, { merge: true });
        tx.set(receipt, { receivedAt: Date.now() }); created = true;
      });
      return { created, conversationId, messageId };
    },
    async getZernioConversation(uid, conversationId) {
      return (await accounts.doc(uid).collection("zernioConversations").doc(conversationId).get()).data();
    },
    async getZernioMessage(uid, conversationId, messageId) {
      return (await accounts.doc(uid).collection("zernioConversations").doc(conversationId).collection("messages").doc(messageId).get()).data();
    },
    async claimZernioAiReply(uid, conversationId, messageId, at) {
      const account = accounts.doc(uid), ref = account.collection("zernioConversations").doc(conversationId).collection("messages").doc(messageId);
      const limitRef = account.collection("limits").doc("zernioAi"); let result = false;
      await db.runTransaction(async tx => {
        const [message, limit] = await tx.getAll(ref, limitRef), value = message.data(), usage = limit.data();
        if (!value || value.direction !== "incoming" || value.type !== "text" || value.unsent || ["sent", "handoff", "skipped", "failed"].includes(value.aiStatus) || value.aiLeaseUntil > at || (value.aiAttempts || 0) >= 3) return;
        const sameMinute = usage && at - usage.minuteSince < 60000, sameDay = usage && at - usage.daySince < 86400000;
        if ((sameMinute ? usage.minuteCount : 0) >= 20 || (sameDay ? usage.dayCount : 0) >= 500) {
          tx.set(ref, { aiStatus: "throttled", aiLeaseUntil: 0, aiUpdatedAt: at }, { merge: true }); return;
        }
        tx.set(ref, { aiStatus: "processing", aiLeaseUntil: at + 180000, aiAttempts: (value.aiAttempts || 0) + 1 }, { merge: true });
        tx.set(limitRef, { minuteSince: sameMinute ? usage.minuteSince : at, minuteCount: (sameMinute ? usage.minuteCount : 0) + 1,
          daySince: sameDay ? usage.daySince : at, dayCount: (sameDay ? usage.dayCount : 0) + 1 }); result = true;
      });
      return result;
    },
    async finishZernioAiReply(uid, conversationId, messageId, status, at) {
      await accounts.doc(uid).collection("zernioConversations").doc(conversationId).collection("messages").doc(messageId)
        .set({ aiStatus: status, aiLeaseUntil: 0, aiUpdatedAt: at }, { merge: true });
    },
    async claimIncomingImage(id, conversationId, messageId, at) {
      const ref = channels.doc(id).collection("conversations").doc(conversationId).collection("messages").doc(messageId);
      return db.runTransaction(async tx => {
        const value = (await tx.get(ref)).data();
        if (!value || value.unsent || value.type !== "image" || value.direction !== "incoming" || value.attachment || value.imageRetryAfter > at) return false;
        tx.set(ref, { imageRetryAfter: at + 60000 }, { merge: true }); return true;
      });
    },
    async finishIncomingImage(id, conversationId, messageId, patch) {
      const ref = channels.doc(id).collection("conversations").doc(conversationId).collection("messages").doc(messageId);
      return db.runTransaction(async tx => {
        const value = (await tx.get(ref)).data();
        if (!value || value.unsent) return value ? { id: messageId, ...value } : null;
        tx.set(ref, patch, { merge: true }); return { id: messageId, ...value, ...patch };
      });
    },
    async reserveUpload(id, conversationId, size, at) {
      const channel = channels.doc(id), limits = channel.collection("limits").doc("uploads");
      await db.runTransaction(async tx => {
        const [conversation, old] = await tx.getAll(channel.collection("conversations").doc(conversationId), limits);
        if (!conversation.exists) throw new HttpError(404, "找不到這段對話。");
        const prior = old.data(), sameDay = prior && at - prior.since < 86400000;
        const bytes = (sameDay ? prior.bytes : 0) + size, count = (sameDay ? prior.count : 0) + 1;
        if (bytes > 100 * 1024 * 1024 || count > 100) throw new HttpError(429, "今日附件上傳額度已達上限，請明天再試。");
        tx.set(limits, { since: sameDay ? prior.since : at, bytes, count });
      });
    },
    async saveAttachment(id, attachmentId, value) { await channels.doc(id).collection("attachments").doc(attachmentId).set(value); },
    async getAttachment(id, attachmentId) { return (await channels.doc(id).collection("attachments").doc(attachmentId).get()).data(); },
    async getMessage(id, conversationId, messageId) { return (await channels.doc(id).collection("conversations").doc(conversationId).collection("messages").doc(messageId).get()).data(); },
    async saveAiSettings(id, settings, at) {
      await channels.doc(id).set({ ai: { ...settings, updatedAt: at } }, { merge: true });
      return { ...settings, updatedAt: at };
    },
    async claimAiReply(id, conversationId, messageId, at) {
      const channel = channels.doc(id), ref = channel.collection("conversations").doc(conversationId).collection("messages").doc(messageId);
      const limitRef = channel.collection("limits").doc("ai");
      let result = false;
      await db.runTransaction(async tx => {
        const [message, limit] = await tx.getAll(ref, limitRef), value = message.data(), usage = limit.data();
        if (!value || value.direction !== "incoming" || value.type !== "text" || value.unsent || ["sent", "handoff", "skipped", "failed"].includes(value.aiStatus)) return;
        if (value.aiLeaseUntil > at || (value.aiAttempts || 0) >= 3) return;
        const sameMinute = usage && at - usage.minuteSince < 60000, sameDay = usage && at - usage.daySince < 86400000;
        if ((sameMinute ? usage.minuteCount : 0) >= 20 || (sameDay ? usage.dayCount : 0) >= 500) {
          tx.set(ref, { aiStatus: "throttled", aiLeaseUntil: 0, aiUpdatedAt: at }, { merge: true });
          return;
        }
        tx.set(ref, { aiStatus: "processing", aiLeaseUntil: at + 60000, aiAttempts: (value.aiAttempts || 0) + 1 }, { merge: true });
        tx.set(limitRef, { minuteSince: sameMinute ? usage.minuteSince : at, minuteCount: (sameMinute ? usage.minuteCount : 0) + 1,
          daySince: sameDay ? usage.daySince : at, dayCount: (sameDay ? usage.dayCount : 0) + 1 });
        result = true;
      });
      return result;
    },
    async finishAiReply(id, conversationId, messageId, status, at) {
      await channels.doc(id).collection("conversations").doc(conversationId).collection("messages").doc(messageId)
        .set({ aiStatus: status, aiLeaseUntil: 0, aiUpdatedAt: at }, { merge: true });
    },
    async recentMessages(id, conversationId, limit = 16) {
      const result = await page(channels.doc(id).collection("conversations").doc(conversationId).collection("messages"), "sentAt", null, limit);
      return result.items.reverse();
    },
    async claimProfile(id, conversationId, at) {
      const ref = channels.doc(id).collection("conversations").doc(conversationId);
      return db.runTransaction(async tx => {
        const value = (await tx.get(ref)).data();
        if (!value || value.profileRefreshAfter > at) return false;
        tx.set(ref, { profileRefreshAfter: at + 60000 }, { merge: true });
        return true;
      });
    },
    async saveProfile(id, conversationId, profile) {
      await channels.doc(id).collection("conversations").doc(conversationId).set(profile, { merge: true });
    },
    async saveCustomer(id, conversationId, profile, at) {
      const ref = channels.doc(id).collection("conversations").doc(conversationId);
      return db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw new HttpError(404, "找不到這位客戶。");
        const prior = snapshot.data().customer || {};
        const customer = { ...profile, notes: Array.isArray(prior.notes) ? prior.notes.slice(0, 30) : [], updatedAt: at };
        tx.set(ref, { customer }, { merge: true });
        return customer;
      });
    },
    async addCustomerNote(id, conversationId, text, at) {
      const ref = channels.doc(id).collection("conversations").doc(conversationId);
      return db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw new HttpError(404, "找不到這位客戶。");
        const prior = snapshot.data().customer || {};
        const notes = [{ id: randomUUID(), text, createdAt: at }, ...(Array.isArray(prior.notes) ? prior.notes : [])].slice(0, 30);
        const customer = { ...prior, notes, updatedAt: at };
        tx.set(ref, { customer }, { merge: true });
        return customer;
      });
    },
    async deleteCustomerNote(id, conversationId, noteId, at) {
      const ref = channels.doc(id).collection("conversations").doc(conversationId);
      return db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw new HttpError(404, "找不到這位客戶。");
        const prior = snapshot.data().customer || {};
        const oldNotes = Array.isArray(prior.notes) ? prior.notes : [];
        const notes = oldNotes.filter(note => note.id !== noteId);
        if (notes.length === oldNotes.length) throw new HttpError(404, "找不到這則記事。");
        const customer = { ...prior, notes, updatedAt: at };
        tx.set(ref, { customer }, { merge: true });
        return customer;
      });
    },
    async prepareReply(id, conversationId, operationId, text, at, attachmentId = null, textParts = null, replyToMessageId = null) {
      if (textParts && (!Array.isArray(textParts) || !textParts.length || textParts.length > 3 || textParts.some(part => typeof part !== "string" || !part.trim() || part.length > 5000) || textParts.join("").replace(/\s/g, "") !== text.replace(/\s/g, ""))) throw new HttpError(400, "分段內容無效。");
      const channel = channels.doc(id), conversation = channel.collection("conversations").doc(conversationId);
      const outbox = channel.collection("outbox").doc(operationId);
      const messageRef = conversation.collection("messages").doc(`out-${operationId}`);
      const limitRef = channel.collection("limits").doc("send");
      let result;
      await db.runTransaction(async tx => {
        const [old, target, limits] = await tx.getAll(outbox, conversation, limitRef);
        if (!target.exists) throw new HttpError(404, "找不到這段對話。");
        const previous = old.data();
        if (previous && (previous.conversationId !== conversationId || previous.text !== text || (previous.attachmentId || null) !== attachmentId)) throw new HttpError(409, "不可用同一筆傳送編號更改內容或收件對象。");
        if (previous && ["sent", "failed"].includes(previous.status)) { result = { ...previous, claimed: false }; return; }
        // Reply has no retry key: after reserving an attempt, never retry it or switch to Push.
        // A crash or timeout may have happened after LINE accepted the message.
        if (previous?.deliveryMode === "reply") { result = { ...previous, claimed: false }; return; }
        if (previous && at - previous.createdAt >= 23 * 60 * 60 * 1000) throw new HttpError(409, "這則訊息已超過安全重試期限，請先到 LINE 確認傳送結果。");
        if (previous?.leaseUntil > at) { result = { ...previous, claimed: false }; return; }
        const rate = limits.data(), active = rate && at - rate.since < 60000;
        if (active && rate.count >= 20) throw new HttpError(429, "傳送頻率過高，請一分鐘後再試。");
        const incoming = !previous && replyToMessageId
          ? (await tx.get(conversation.collection("messages").doc(replyToMessageId))).data() : null;
        const replyToken = incoming?.direction === "incoming" && !incoming.unsent && incoming.replyExpiresAt > at ? incoming.replyToken : null;
        let attachment;
        if (attachmentId) {
          const stored = (await tx.get(channel.collection("attachments").doc(attachmentId))).data();
          if (!stored || stored.conversationId !== conversationId || stored.expiresAt <= at + 86400000) throw new HttpError(400, "附件無效、已過期或不屬於這段對話，請重新上傳。");
          attachment = { id: attachmentId, name: stored.name, kind: stored.kind, url: stored.url, size: stored.size, expiresAt: stored.expiresAt };
        }
        const lineMessages = [];
        if (attachment) lineMessages.push(attachment.kind === "image" ? { type: "image", originalContentUrl: attachment.url, previewImageUrl: attachment.url } : { type: "text", text: `📎 ${attachment.name}\n${attachment.url}\n（下載連結 30 天內有效）` });
        if (text.trim()) lineMessages.push(...(textParts || [text]).map(part => ({ type: "text", text: part })));
        const message = { id: `out-${operationId}`, operationId, direction: "outgoing", type: attachment?.kind || "text", text, ...(attachment ? { attachment } : {}), sentAt: previous?.createdAt ?? at, status: "pending", note: "正在確認傳送結果", unsent: false };
        const operation = { conversationId, text, attachmentId, lineMessages: previous?.lineMessages || lineMessages, to: target.data().sourceId, retryKey: previous?.retryKey ?? randomUUID(), createdAt: previous?.createdAt ?? at, leaseUntil: at + 20000, status: "pending", message,
          deliveryMode: previous?.deliveryMode || (replyToken ? "reply" : "push") };
        tx.set(outbox, operation); tx.set(messageRef, message);
        tx.set(limitRef, { since: active ? rate.since : at, count: active ? rate.count + 1 : 1 });
        result = { ...operation, claimed: true, retried: !!previous, ...(replyToken ? { replyToken } : {}) };
      });
      return result;
    },
    async finishReply(id, operationId, status, note) {
      const channel = channels.doc(id), outbox = channel.collection("outbox").doc(operationId);
      let message;
      await db.runTransaction(async tx => {
        const operation = (await tx.get(outbox)).data();
        if (!operation) throw new HttpError(404, "找不到傳送紀錄。");
        const conversation = channel.collection("conversations").doc(operation.conversationId);
        const summary = (await tx.get(conversation)).data();
        // An acknowledged success must never be downgraded by an older retry.
        if (operation.status === "sent") { message = operation.message; return; }
        message = { ...operation.message, status, note };
        tx.set(outbox, { status, message, leaseUntil: 0 }, { merge: true });
        tx.set(conversation.collection("messages").doc(message.id), message);
        if (status === "sent" && (!summary || message.sentAt >= summary.updatedAt)) tx.set(conversation, { lastText: `你：${message.attachment ? `[${message.type === "image" ? "圖片" : "文件"}] ${message.attachment.name} ` : ""}${message.text}`, lastMessageId: message.id, updatedAt: message.sentAt }, { merge: true });
      });
      return message;
    },
    async getChannel(id) { return (await channels.doc(id).get()).data() || null; },
    async getConversation(id, conversationId) { return (await channels.doc(id).collection("conversations").doc(conversationId).get()).data() || null; },
    async account(uid) {
      const account = (await accounts.doc(uid).get()).data();
      if (!account?.channelId) return null;
      const channel = (await channels.doc(account.channelId).get()).data();
      if (channel?.ownerUid !== uid) throw new HttpError(403, "無權查看此 OA。");
      return channel;
    },
    async bindingAttempt(uid, now) {
      const ref = state.collection("bindingLimits").doc(uid);
      await db.runTransaction(async tx => {
        const data = (await tx.get(ref)).data();
        const active = data && now - data.since < 60000;
        if (active && data.count >= 5) throw new HttpError(429, "嘗試次數過多，請稍後再試。");
        tx.set(ref, { since: active ? data.since : now, count: active ? data.count + 1 : 1 });
      });
    },
    async bind(uid, channel) {
      await db.runTransaction(async tx => {
        const [existing, account] = await tx.getAll(channels.doc(channel.channelId), accounts.doc(uid));
        if (existing.exists && existing.data().ownerUid !== uid) throw new HttpError(409, "這個 OA 已綁定其他網站帳號。");
        if (account.data()?.channelId && account.data().channelId !== channel.channelId) throw new HttpError(409, "第一版每個網站帳號可綁定一個 OA，請使用原本的 Channel ID。");
        tx.set(channels.doc(channel.channelId), { ...channel, updatedAt: Date.now() }, { merge: true });
        tx.set(accounts.doc(uid), { channelId: channel.channelId }, { merge: true });
      });
    },
    async markVerified(id, at, received) {
      await channels.doc(id).set({ verifiedAt: at, ...(received ? { lastReceivedAt: at } : {}) }, { merge: true });
    },
    async ingest(id, event, reply = null) {
      const channel = channels.doc(id);
      const conversation = channel.collection("conversations").doc(event.conversationId);
      const message = conversation.collection("messages").doc(event.messageId);
      const receipt = channel.collection("receipts").doc(event.eventId);
      await db.runTransaction(async tx => {
        const [seen, previous, oldMessage] = await tx.getAll(receipt, conversation, message);
        if (seen.exists) return;
        const old = oldMessage.data();
        const summary = previous.data();
        // Tombstones also cover an unsend event delivered before its original message.
        if (event.unsent) {
          tx.set(message, { type: "unsend", text: "[訊息已收回]", unsent: true, sentAt: old?.sentAt ?? event.sentAt, direction: "incoming" });
          if (summary?.lastMessageId === event.messageId) tx.update(conversation, { lastText: "[訊息已收回]" });
        } else if (!old?.unsent) {
          tx.set(message, { type: event.type, text: event.text, sentAt: event.sentAt, unsent: false, direction: "incoming", ...(!old && reply ? reply : {}) });
          const createdAt = summary?.createdAt == null ? event.sentAt : Math.min(summary.createdAt, event.sentAt);
          if (!summary || event.sentAt >= summary.updatedAt) tx.set(conversation, { sourceType: event.sourceType, sourceId: event.sourceId, lastText: event.text, lastMessageId: event.messageId, updatedAt: event.sentAt, createdAt }, { merge: true });
          else if (createdAt !== summary.createdAt) tx.set(conversation, { createdAt }, { merge: true });
        }
        tx.set(receipt, { receivedAt: Date.now() });
      });
    },
    conversations(id, before) { return page(channels.doc(id).collection("conversations"), "updatedAt", before, 30); },
    async messages(id, conversationId, before) {
      const result = await page(channels.doc(id).collection("conversations").doc(conversationId).collection("messages"), "sentAt", before, 50);
      result.items = result.items.map(({ replyToken, replyExpiresAt, ...message }) => message);
      return result;
    },
  };
}
