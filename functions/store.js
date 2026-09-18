import { HttpError } from "./core.js";
import { randomUUID } from "node:crypto";

export function createStore(db) {
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
    async bindZernioFacebook(uid, profileId, account, at) {
      const ref = accounts.doc(uid);
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data() || {}, prior = old.zernio || {};
        if (prior.profileId !== profileId) throw new HttpError(409, "Zernio Profile 與網站帳號不符。");
        if (prior.facebook?.accountId && prior.facebook.accountId !== account.accountId) throw new HttpError(409, "此網站帳號已連接其他 Facebook 粉絲專頁。");
        tx.set(ref, { zernio: { ...prior, facebook: { ...account, connectedAt: at }, updatedAt: at } }, { merge: true });
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
        if (!value || value.direction !== "incoming" || value.type !== "text" || value.unsent || value.aiStatus === "sent") return;
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
    async prepareReply(id, conversationId, operationId, text, at, attachmentId = null) {
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
        if (previous && at - previous.createdAt >= 23 * 60 * 60 * 1000) throw new HttpError(409, "這則訊息已超過安全重試期限，請先到 LINE 確認傳送結果。");
        if (previous?.leaseUntil > at) { result = { ...previous, claimed: false }; return; }
        const rate = limits.data(), active = rate && at - rate.since < 60000;
        if (active && rate.count >= 20) throw new HttpError(429, "傳送頻率過高，請一分鐘後再試。");
        let attachment;
        if (attachmentId) {
          const stored = (await tx.get(channel.collection("attachments").doc(attachmentId))).data();
          if (!stored || stored.conversationId !== conversationId || stored.expiresAt <= at + 86400000) throw new HttpError(400, "附件無效、已過期或不屬於這段對話，請重新上傳。");
          attachment = { id: attachmentId, name: stored.name, kind: stored.kind, url: stored.url, size: stored.size, expiresAt: stored.expiresAt };
        }
        const lineMessages = [];
        if (attachment) lineMessages.push(attachment.kind === "image" ? { type: "image", originalContentUrl: attachment.url, previewImageUrl: attachment.url } : { type: "text", text: `📎 ${attachment.name}\n${attachment.url}\n（下載連結 30 天內有效）` });
        if (text.trim()) lineMessages.push({ type: "text", text });
        const message = { id: `out-${operationId}`, operationId, direction: "outgoing", type: attachment?.kind || "text", text, ...(attachment ? { attachment } : {}), sentAt: previous?.createdAt ?? at, status: "pending", note: "正在確認傳送結果", unsent: false };
        const operation = { conversationId, text, attachmentId, lineMessages: previous?.lineMessages || lineMessages, to: target.data().sourceId, retryKey: previous?.retryKey ?? randomUUID(), createdAt: previous?.createdAt ?? at, leaseUntil: at + 20000, status: "pending", message };
        tx.set(outbox, operation); tx.set(messageRef, message);
        tx.set(limitRef, { since: active ? rate.since : at, count: active ? rate.count + 1 : 1 });
        result = { ...operation, claimed: true, retried: !!previous };
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
    async account(uid) {
      const account = (await accounts.doc(uid).get()).data();
      if (!account) return null;
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
        if (account.exists && account.data().channelId !== channel.channelId) throw new HttpError(409, "第一版每個網站帳號可綁定一個 OA，請使用原本的 Channel ID。");
        tx.set(channels.doc(channel.channelId), { ...channel, updatedAt: Date.now() }, { merge: true });
        tx.set(accounts.doc(uid), { channelId: channel.channelId });
      });
    },
    async markVerified(id, at, received) {
      await channels.doc(id).set({ verifiedAt: at, ...(received ? { lastReceivedAt: at } : {}) }, { merge: true });
    },
    async ingest(id, event) {
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
          tx.set(message, { type: event.type, text: event.text, sentAt: event.sentAt, unsent: false, direction: "incoming" });
          const createdAt = summary?.createdAt == null ? event.sentAt : Math.min(summary.createdAt, event.sentAt);
          if (!summary || event.sentAt >= summary.updatedAt) tx.set(conversation, { sourceType: event.sourceType, sourceId: event.sourceId, lastText: event.text, lastMessageId: event.messageId, updatedAt: event.sentAt, createdAt }, { merge: true });
          else if (createdAt !== summary.createdAt) tx.set(conversation, { createdAt }, { merge: true });
        }
        tx.set(receipt, { receivedAt: Date.now() });
      });
    },
    conversations(id, before) { return page(channels.doc(id).collection("conversations"), "updatedAt", before, 30); },
    messages(id, conversationId, before) { return page(channels.doc(id).collection("conversations").doc(conversationId).collection("messages"), "sentAt", before, 50); },
  };
}
