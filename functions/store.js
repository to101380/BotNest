import { workflowRef, reopenedWorkflow } from "./conversation-workflow.js";
import { visibleRetainedMessage, retentionActive, messageDue } from "./retention-policy.js";
import { createMonitor, aiMetrics } from "./security-monitor.js";
import { HttpError } from "./core.js";
import { createHash, randomUUID } from "node:crypto";
import { normalizeAiSettings } from "./ai-policy.js";
import { createUsageStore } from "./ai-usage.js";
import { FieldPath } from "firebase-admin/firestore";
import { AsyncLocalStorage } from "node:async_hooks";

const digestId = value => createHash("sha256").update(String(value)).digest("hex");

export function createStore(db) {
  const monitor = createMonitor(db);
  const state = db.collection("botnest").doc("state");
  const channels = state.collection("channels");
  const accounts = state.collection("accounts");
  const readScope = new AsyncLocalStorage();
  function accountRead(ref) {
    const pending = readScope.getStore();
    if (!pending) return ref.get();
    if (!pending.has(ref.path)) pending.set(ref.path, ref.get());
    return pending.get(ref.path);
  }
  const rows = snapshot => snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  // Query only existing overrides. Individual gets also bill for missing docs.
  async function sparseRows(collection, ids) {
    const unique = [...new Set(ids)], found = new Map();
    await Promise.all(Array.from({ length: Math.ceil(unique.length / 30) }, async (_, index) => {
      const result = await collection.where(FieldPath.documentId(), "in", unique.slice(index * 30, index * 30 + 30)).get();
      for (const doc of result.docs) found.set(doc.id, doc.data());
    }));
    return found;
  }
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
    async retentionSettings(uid) { return (await accounts.doc(uid).collection("retention").doc("settings").get()).data(); },
    async retentionSave(uid, value, revision) {
      const ref = accounts.doc(uid).collection("retention").doc("settings");
      await db.runTransaction(async tx => { const old = (await tx.get(ref)).data(); if (old?.revision !== revision) throw new HttpError(409, "設定已更新，請重新整理。"); tx.set(ref, value); });
    },
    async retainedMessages(uid, id, items, at) {
      const [policy, workflow] = await Promise.all([this.retentionSettings(uid), workflowRef(accounts.doc(uid), id).get()]);
      return items.filter(m => visibleRetainedMessage(m, policy, workflow.data(), at)).map(m => {
        if (!retentionActive(policy, at) || m.sentAt + policy.attachmentDays * 86400000 > at) return m;
        const value = { ...m, attachmentExpired: ["image", "audio", "file"].includes(m.type) || !!m.attachment, imageNote: "附件已到期" };
        delete value.audioTicket;
        if (m.attachment) value.attachment = { name: m.attachment.name, kind: m.attachment.kind, url: "", expiresAt: 0 };
        return value;
      });
    },
    async retainedConversations(uid, items) {
      const found = await sparseRows(accounts.doc(uid).collection("conversationWorkflow"), items.map(item => digestId(item.id)));
      return items.filter(item => !found.get(digestId(item.id))?.purgedAt);
    },
    // A snapshot lives for one read-only endpoint invocation, never across users/requests.
    withReadSnapshot(run) { return readScope.run(new Map(), run); },
    ...createUsageStore(db),
    async aiKnowledge(uid) {
      return rows(await accounts.doc(uid).collection("aiKnowledge").where("deleted", "==", false).limit(40).get()).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async aiKnowledgeItem(uid, id) {
      const item = (await accounts.doc(uid).collection("aiKnowledge").doc(id).get()).data();
      return item && !item.deleted ? { id, ...item } : null;
    },
    async saveAiKnowledge(uid, id, item, at, { createOnly = false } = {}) {
      const account = accounts.doc(uid), ref = account.collection("aiKnowledge").doc(id), meter = account.collection("limits").doc("knowledge");
      return db.runTransaction(async tx => {
        const [prior, usage] = await tx.getAll(ref, meter), old = prior.data(), current = usage.data() || { count: 0, characters: 0 };
        if (old?.deleted) throw new HttpError(404, "這筆知識已刪除，請重新新增。");
        if (createOnly && old) return { id, ...old };
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
    async aiControls(uid, provider, ids) {
      const found = await sparseRows(accounts.doc(uid).collection("aiConversations"), ids.map(id => `${provider}-${id}`));
      return new Map(ids.map(id => [id, found.get(`${provider}-${id}`) || { mode: "auto", pausedUntil: 0, revision: 0 }]));
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
      const value = (await accountRead(accounts.doc(uid))).data();
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
    async validateZernioState(uid, platform, profileId, stateHash, at) {
      const pending = (await accounts.doc(uid).collection("security").doc("oauth-" + platform).get()).data();
      if (!pending || pending.used || pending.expiresAt <= at || pending.profileId !== profileId || pending.stateHash !== stateHash) throw new HttpError(403, "社群授權已過期或已使用，請重新連接。");
    },
    async saveZernioState(uid, platform, profileId, stateHash, at) {
      const ref = accounts.doc(uid).collection("security").doc("oauth-" + platform);
      await ref.set({ profileId, stateHash, expiresAt: at + 10 * 60000, used: false });
    },
    async bindZernioPlatform(uid, profileId, platform, account, at, stateHash = null) {
      if (!["facebook", "instagram"].includes(platform)) throw new HttpError(400, "不支援的渠道。");
      const ref = accounts.doc(uid);
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data() || {}, prior = old.zernio || {};
        const stateRef = ref.collection("security").doc("oauth-" + platform);
        if (stateHash !== null) {
          const pending = (await tx.get(stateRef)).data();
          if (!pending || pending.used || pending.expiresAt <= at || pending.profileId !== profileId || pending.stateHash !== stateHash) throw new HttpError(403, "社群授權已過期或已使用，請重新連接。");
        }
        if (prior.profileId !== profileId) throw new HttpError(409, "Zernio Profile 與網站帳號不符。");
        if (prior[platform]?.accountId && prior[platform].accountId !== account.accountId) throw new HttpError(409, "此網站帳號已連接此渠道的其他帳號。");
        if (stateHash !== null) tx.set(stateRef, { used: true, expiresAt: at });
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
    async reserveSocialUpload(uid, size, at) {
      const ref = accounts.doc(uid).collection("limits").doc("socialUploads");
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data(), active = old && at - old.since < 86400000;
        const bytes = (active ? old.bytes : 0) + size, count = (active ? old.count : 0) + 1;
        if (bytes > 100 * 1024 * 1024 || count > 100) throw new HttpError(429, "今日附件上傳額度已達上限，請明天再試。");
        tx.set(ref, { since: active ? old.since : at, bytes, count });
      });
    },
    async saveSocialAttachment(id, attachment) { await state.collection("socialAttachments").doc(id).set(attachment); },
    async getSocialAttachment(id) { return (await state.collection("socialAttachments").doc(id).get()).data(); },
    async prepareSocialAttachmentReply(uid, operationId, value, at) {
      const ref = accounts.doc(uid).collection("socialAttachmentOutbox").doc(operationId);
      return db.runTransaction(async tx => {
        const previous = (await tx.get(ref)).data();
        const fingerprint = digestId(JSON.stringify(value));
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new HttpError(409, "不可用同一筆傳送編號更改附件、內容或收件對象。");
          return { ...previous, claimed: false };
        }
        const stored = (await tx.get(state.collection("socialAttachments").doc(value.attachmentId))).data();
        if (!stored || stored.ownerUid !== uid || stored.platform !== value.platform || stored.accountId !== value.accountId || stored.conversationId !== value.conversationId || stored.expiresAt <= at + 86400000) throw new HttpError(400, "附件無效、已過期或不屬於這段對話，請重新上傳。");
        if (value.platform === "instagram" && stored.kind !== "image") throw new HttpError(400, "Instagram 僅支援上傳圖片。");
        const { id, name, kind, url, size, expiresAt } = stored;
        const attachment = { id, name, kind, url, size, expiresAt };
        const message = { id: `out-${operationId}`, operationId, direction: "outgoing", type: kind, text: value.text, attachment, sentAt: at, status: "uncertain", note: "傳送結果待確認；請先到原平台查看，勿重複傳送。", unsent: false };
        const operation = { fingerprint, message, platform: value.platform, accountId: value.accountId, conversationId: value.conversationId, createdAt: at };
        tx.set(ref, operation);
        return { ...operation, claimed: true };
      });
    },
    async finishSocialAttachmentReply(uid, operationId, message) {
      await accounts.doc(uid).collection("socialAttachmentOutbox").doc(operationId).set({ message }, { merge: true });
      return message;
    },
    async zernioCustomer(uid, conversationId) {
      return (await accounts.doc(uid).collection("zernioCustomers").doc(conversationId).get()).data()?.customer || {};
    },
    async zernioCustomers(uid, ids) {
      const found = await sparseRows(accounts.doc(uid).collection("zernioCustomers"), ids);
      return new Map(ids.map(id => [id, found.get(id)?.customer || {}]));
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
      const value = (await accountRead(accounts.doc(uid))).data() || {};
      if (value.access?.disabled === true) return { ...value.ai, enabled: false };
      if (value.ai) return value.ai;
      if (!value.channelId) return {};
      return (await accountRead(channels.doc(value.channelId))).data()?.ai || {};
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
        const workflow = workflowRef(account, `${event.provider}-${conversationId}`);
        const [seen, prior, priorMessage, workflowSnapshot, policySnapshot] = await tx.getAll(receipt, conversation, message, workflow, account.collection("retention").doc("settings"));
        if (seen.exists || priorMessage.exists) return;
        if (retentionActive(policySnapshot.data(), Date.now()) && messageDue(event, policySnapshot.data(), Date.now()) || (workflowSnapshot.data()?.purgedAt || workflowSnapshot.data()?.lastPurgedAt) && event.sentAt <= (workflowSnapshot.data().purgedAt || workflowSnapshot.data().lastPurgedAt)) return;
        const reopened = reopenedWorkflow(workflowSnapshot.data(), event.sentAt);
        if (reopened) tx.set(workflow, reopened);
        const old = prior.data(), stored = { ...event, id: messageId, conversationId, direction: "incoming", type: event.type || "text", unsent: false };
        tx.set(message, stored);
        if (!old || event.sentAt >= old.updatedAt) tx.set(conversation, { remoteConversationId: event.remoteConversationId, accountId: event.accountId,
          displayName: event.displayName, pictureUrl: event.pictureUrl, lastText: event.text, latestIncomingId: messageId, updatedAt: event.sentAt,
          retentionPurgedAt: 0, retentionEmpty: false, createdAt: old?.createdAt == null ? event.sentAt : Math.min(old.createdAt, event.sentAt) }, { merge: true });
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
        if (!value || value.direction !== "incoming" || !["text", "image", "audio"].includes(value.type) || value.unsent || ["sent", "handoff", "skipped", "failed"].includes(value.aiStatus) || value.aiLeaseUntil > at || (value.aiAttempts || 0) >= 3) return;
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
        if (!value || value.unsent || value.attachmentExpired || value.type !== "image" || value.direction !== "incoming" || value.attachment || value.imageRetryAfter > at) return false;
        tx.set(ref, { imageRetryAfter: at + 60000 }, { merge: true }); return true;
      });
    },
    async finishIncomingImage(id, conversationId, messageId, patch) {
      const ref = channels.doc(id).collection("conversations").doc(conversationId).collection("messages").doc(messageId);
      return db.runTransaction(async tx => {
        const value = (await tx.get(ref)).data();
        if (!value || value.unsent || value.attachmentExpired) return value ? { id: messageId, ...value } : null;
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
        if (!value || value.direction !== "incoming" || !["text", "image", "audio"].includes(value.type) || value.unsent || ["sent", "handoff", "skipped", "failed"].includes(value.aiStatus)) return;
        if (value.aiLeaseUntil > at || (value.aiAttempts || 0) >= 3) return;
        const sameMinute = usage && at - usage.minuteSince < 60000, sameDay = usage && at - usage.daySince < 86400000;
        if ((sameMinute ? usage.minuteCount : 0) >= 20 || (sameDay ? usage.dayCount : 0) >= 500) {
          tx.set(ref, { aiStatus: "throttled", aiLeaseUntil: 0, aiUpdatedAt: at }, { merge: true });
          return;
        }
        tx.set(ref, { aiStatus: "processing", aiLeaseUntil: at + 120000, aiAttempts: (value.aiAttempts || 0) + 1 }, { merge: true });
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
        if (attachment) lineMessages.push(attachment.kind === "image" ? { type: "image", originalContentUrl: attachment.url, previewImageUrl: attachment.url } : { type: "text", text: `📎 ${attachment.name}\n${attachment.url}\n（下載連結 90 天內有效）` });
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
    async isAccountDisabled(uid) { return (await accountRead(accounts.doc(uid))).data()?.access?.disabled === true; },
    async getConversation(id, conversationId) { return (await channels.doc(id).collection("conversations").doc(conversationId).get()).data() || null; },
    async account(uid) {
      const account = (await accountRead(accounts.doc(uid))).data();
      if (!account?.channelId) return null;
      const channel = (await accountRead(channels.doc(account.channelId))).data();
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
        const owner = (await tx.get(channel)).data()?.ownerUid;
        const workflow = owner ? workflowRef(accounts.doc(owner), event.conversationId) : null;
        const [seen, previous, oldMessage, workflowSnapshot, policySnapshot] = await tx.getAll(receipt, conversation, message, ...(workflow ? [workflow, accounts.doc(owner).collection("retention").doc("settings")] : []));
        if (seen.exists) return;
        if (retentionActive(policySnapshot?.data(), Date.now()) && messageDue(event, policySnapshot.data(), Date.now()) || (workflowSnapshot?.data()?.purgedAt || workflowSnapshot?.data()?.lastPurgedAt) && event.sentAt <= (workflowSnapshot.data().purgedAt || workflowSnapshot.data().lastPurgedAt)) return;
        const old = oldMessage.data();
        const summary = previous.data();
        // Tombstones also cover an unsend event delivered before its original message.
        if (event.unsent) {
          tx.set(message, { type: "unsend", text: "[訊息已收回]", unsent: true, sentAt: old?.sentAt ?? event.sentAt, direction: "incoming" });
          if (summary?.lastMessageId === event.messageId) tx.update(conversation, { lastText: "[訊息已收回]" });
        } else if (!old?.unsent) {
          const reopened = !old && reopenedWorkflow(workflowSnapshot?.data(), event.sentAt);
          if (reopened) tx.set(workflow, reopened);
          tx.set(message, { type: event.type, text: event.text, sentAt: event.sentAt, unsent: false, direction: "incoming", ...(!old && reply ? reply : {}) });
          const createdAt = summary?.createdAt == null ? event.sentAt : Math.min(summary.createdAt, event.sentAt);
          if (!summary || event.sentAt >= summary.updatedAt) tx.set(conversation, { sourceType: event.sourceType, sourceId: event.sourceId, lastText: event.text, lastMessageId: event.messageId, updatedAt: event.sentAt, createdAt, retentionPurgedAt: 0, retentionEmpty: false }, { merge: true });
          else if (createdAt !== summary.createdAt) tx.set(conversation, { createdAt }, { merge: true });
        }
        tx.set(receipt, { receivedAt: Date.now() });
      });
    },
    async conversations(id, before, includePurgedCustomers = false) { const result = await page(channels.doc(id).collection("conversations"), "updatedAt", before, 30); if (!includePurgedCustomers) result.items = result.items.filter(item => !item.retentionPurgedAt); return result; },
    async messages(id, conversationId, before) {
      const result = await page(channels.doc(id).collection("conversations").doc(conversationId).collection("messages"), "sentAt", before, 50);
      const owner = (await accountRead(channels.doc(id))).data()?.ownerUid;
      if (owner) result.items = await this.retainedMessages(owner, conversationId, result.items, Date.now());
      result.items = result.items.map(({ replyToken, replyExpiresAt, ...message }) => message);
      return result;
    },
  };
}
