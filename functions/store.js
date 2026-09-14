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
    async prepareReply(id, conversationId, operationId, text, at) {
      const channel = channels.doc(id), conversation = channel.collection("conversations").doc(conversationId);
      const outbox = channel.collection("outbox").doc(operationId);
      const messageRef = conversation.collection("messages").doc(`out-${operationId}`);
      const limitRef = channel.collection("limits").doc("send");
      let result;
      await db.runTransaction(async tx => {
        const [old, target, limits] = await tx.getAll(outbox, conversation, limitRef);
        if (!target.exists) throw new HttpError(404, "找不到這段對話。");
        const previous = old.data();
        if (previous && (previous.conversationId !== conversationId || previous.text !== text)) throw new HttpError(409, "不可用同一筆傳送編號更改內容或收件對象。");
        if (previous && ["sent", "failed"].includes(previous.status)) { result = { ...previous, claimed: false }; return; }
        if (previous && at - previous.createdAt >= 23 * 60 * 60 * 1000) throw new HttpError(409, "這則訊息已超過安全重試期限，請先到 LINE 確認傳送結果。");
        if (previous?.leaseUntil > at) { result = { ...previous, claimed: false }; return; }
        const rate = limits.data(), active = rate && at - rate.since < 60000;
        if (active && rate.count >= 20) throw new HttpError(429, "傳送頻率過高，請一分鐘後再試。");
        const message = { id: `out-${operationId}`, operationId, direction: "outgoing", type: "text", text, sentAt: previous?.createdAt ?? at, status: "pending", note: "正在確認傳送結果", unsent: false };
        const operation = { conversationId, text, to: target.data().sourceId, retryKey: previous?.retryKey ?? randomUUID(), createdAt: previous?.createdAt ?? at, leaseUntil: at + 20000, status: "pending", message };
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
        if (status === "sent" && (!summary || message.sentAt >= summary.updatedAt)) tx.set(conversation, { lastText: `你：${message.text}`, lastMessageId: message.id, updatedAt: message.sentAt }, { merge: true });
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
          if (!summary || event.sentAt >= summary.updatedAt) tx.set(conversation, { sourceType: event.sourceType, sourceId: event.sourceId, lastText: event.text, lastMessageId: event.messageId, updatedAt: event.sentAt }, { merge: true });
        }
        tx.set(receipt, { receivedAt: Date.now() });
      });
    },
    conversations(id, before) { return page(channels.doc(id).collection("conversations"), "updatedAt", before, 30); },
    messages(id, conversationId, before) { return page(channels.doc(id).collection("conversations").doc(conversationId).collection("messages"), "sentAt", before, 50); },
  };
}
