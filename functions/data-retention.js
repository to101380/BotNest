import { createHash, randomUUID } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { DAY, initialPolicy, retentionActive, trashDeadline, attachmentDue, attachmentCreated, messageDue, safeMessage } from './retention-policy.js';
import { workflowRef } from './conversation-workflow.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const emptyStats = () => ({ messages: 0, files: 0, fileBytes: 0, messagesDue: 0, filesDue: 0, trashDue: 0, messagesIn7Days: 0, filesIn7Days: 0, trashIn7Days: 0, deletedMessages: 0, deletedFiles: 0, deletedRecords: 0 });
const PHASES = ['line', 'social', 'workflow', 'lineAttachments', 'socialAttachments', 'lineOutbox', 'socialOutbox', 'aiLogs', 'lineReceipts', 'socialReceipts'];
export function createRetentionService({ db, bucket, now = Date.now }) {
  const state = db.collection('botnest').doc('state'), accounts = state.collection('accounts');
  const account = uid => accounts.doc(uid), policyRef = uid => account(uid).collection('retention').doc('settings');
  const previewRef = uid => account(uid).collection('retention').doc('preview'), jobs = uid => account(uid).collection('dataJobs');
  const objectPrefix = (uid, jobId) => `botnest/backups/${hash(uid)}/${jobId}/`;
  async function ensurePolicy(uid) {
    return db.runTransaction(async tx => {
      const ref = policyRef(uid), old = (await tx.get(ref)).data(); if (old) return old;
      const value = initialPolicy(now()); tx.set(ref, value); tx.set(account(uid), { retentionRegisteredAt: now() }, { merge: true }); return value;
    });
  }
  async function page(collection, cursor, count = 100) {
    let query = collection.orderBy(FieldPath.documentId()).limit(count); if (cursor) query = query.startAfter(cursor); return (await query.get()).docs;
  }
  async function context(uid) {
    const a = (await account(uid).get()).data() || {};
    let channel = null, channelData = null;
    if (a.channelId) { const ref = state.collection('channels').doc(a.channelId), value = (await ref.get()).data(); if (value?.ownerUid === uid) { channel = ref; channelData = value; } }
    return { account: account(uid), channel, channelData, accountData: a };
  }
  async function queue(uid, type) {
    if (type !== 'scan') throw Object.assign(new Error('找不到此功能。'), { status: 404 });
    const at = now(), p = await ensurePolicy(uid), ref = jobs(uid).doc(randomUUID());
    return db.runTransaction(async tx => {
      const control = account(uid).collection('retention').doc('queue'), old = (await tx.get(control)).data() || {};
      if (old[type]?.at > at - 60000) throw Object.assign(new Error('已有工作正在準備，請稍後再試。'), { status: 429 });
      if (old[type]?.id) {
        const previous = (await tx.get(jobs(uid).doc(old[type].id))).data();
        if (previous && ['queued', 'working'].includes(previous.status) && previous.expiresAt > at) {
          return old[type].id;
        }
      }
      tx.set(control, { [type]: { at, id: ref.id } }, { merge: true });
      tx.set(ref, { type, status: 'queued', createdAt: at, snapshotAt: at, expiresAt: at + 7 * DAY, policyRevision: p.revision, cursor: {}, stats: emptyStats(), attempts: 0 });
      return ref.id;
    });
  }
  async function summary(uid) {
    const policy = await ensurePolicy(uid), preview = (await previewRef(uid).get()).data() || null;
    const docs = (await jobs(uid).orderBy('createdAt', 'desc').limit(12).get()).docs;
    return { policy, preview, jobs: docs.filter(doc => doc.data().type === 'scan').map(doc => { const j = doc.data(); return { id: doc.id, type: j.type, status: j.expiresAt <= now() ? 'expired' : j.status, createdAt: j.createdAt, expiresAt: j.expiresAt, error: j.status === 'failed' ? '工作失敗，請重新執行。' : null }; }) };
  }
  function conversationCollection(ctx, phase) { return phase === 'line' ? ctx.channel?.collection('conversations') : ctx.account.collection('zernioConversations'); }
  function workflowId(phase, doc) { return phase === 'line' ? doc.id : `${doc.data().provider || 'facebook'}-${doc.id}`; }
  async function deleteObject(path, ctx, value, uid) {
    if (!path) return false;
    const allowed = ctx.channel && path.startsWith(`botnest/${ctx.channel.id}/`) || path.startsWith(`botnest/social/${hash(uid)}/`);
    if (!allowed || path.includes('..') || !/^[\w/-]+$/.test(path)) throw Error('Attachment owner/path mismatch');
    const file = bucket.file(path); let metadata;
    try { [metadata] = await file.getMetadata(); } catch (e) { if (e.code === 404) return false; throw e; }
    await file.delete({ ifGenerationMatch: metadata.generation, ignoreNotFound: true }); return true;
  }
  async function expireMessage(ref, wfRef, uid, at, policy, stats) {
    await db.runTransaction(async tx => {
      const [m, w, p] = await tx.getAll(ref, wfRef, policyRef(uid)); const value = m.data(), wf = w.data();
      if (!value || !retentionActive(p.data(), at)) return;
      const trash = wf?.purging && wf.trashed && value.sentAt <= wf.purgeBefore;
      if (messageDue(value, p.data(), at) || trash) { tx.delete(ref); stats.deletedMessages++; return; }
      const due = ['image', 'audio', 'file'].includes(value.type) && value.sentAt + p.data().attachmentDays * DAY <= at || value.attachment && attachmentDue(value.attachment, p.data(), at);
      if (due && !value.attachmentExpired) {
        const result = { ...value, attachmentExpired: true, imageNote: '附件已到期', attachments: [], ...(value.attachment ? { attachment: { name: value.attachment.name || '附件', kind: value.attachment.kind || value.type, expiresAt: 0, url: '' } } : {}) };
        delete result.audioTicket; delete result.imageRetryAfter; tx.set(ref, result); stats.deletedRecords++;
      }
    });
  }
  async function repairPreview(ref) {
    const latest = (await ref.collection('messages').orderBy('sentAt', 'desc').limit(1).get()).docs[0];
    await db.runTransaction(async tx => {
      const old = (await tx.get(ref)).data(); if (!old) return;
      // Never overwrite a newer webhook preview racing with cleanup.
      if (latest && old.updatedAt > latest.data().sentAt) {
        const current = old.lastMessageId ? await tx.get(ref.collection('messages').doc(old.lastMessageId)) : null;
        if (current?.exists) return;
      }
      if (latest) tx.set(ref, { lastText: latest.data().text || '', lastMessageId: latest.id, updatedAt: latest.data().sentAt }, { merge: true });
      else tx.set(ref, { lastText: '', lastMessageId: '', retentionEmpty: true }, { merge: true });
    });
  }
  async function scanStep(uid, job, ctx) {
    const at = now(), p = await ensurePolicy(uid), stats = { ...emptyStats(), ...job.stats }, cursor = { ...job.cursor };
    if (p.revision !== job.policyRevision) return { status: 'cancelled', finishedAt: at };
    const index = cursor.phaseIndex || 0, phase = PHASES[index];
    if (!phase) {
      const preview = { ...stats, finishedAt: at, policyRevision: p.revision, cleanupEnabled: retentionActive(p, at) };
      await previewRef(uid).set(preview); return { status: 'ready', finishedAt: at, stats };
    }
    const advance = () => ({ cursor: { phaseIndex: index + 1 }, stats });
    if (phase === 'line' || phase === 'social') {
      const collection = conversationCollection(ctx, phase); if (!collection) return advance();
      const docs = cursor.current ? [await collection.doc(cursor.current).get()] : await page(collection, cursor.after, 1);
      const doc = docs[0]; if (!doc?.exists) return advance();
      const wfRef = workflowRef(ctx.account, workflowId(phase, doc)); let wf = (await wfRef.get()).data();
      if (!cursor.current) {
        const deadline = trashDeadline(wf, p);
        if (deadline && deadline <= at) stats.trashDue++;
        if (deadline && deadline <= at + 7 * DAY) stats.trashIn7Days++;
        if (retentionActive(p, at) && deadline && deadline <= at) {
          wf = await db.runTransaction(async tx => {
            const [w, currentPolicy] = await tx.getAll(wfRef, policyRef(uid)); const value = w.data(), policy = currentPolicy.data();
            if (!value?.trashed || !retentionActive(policy, at) || trashDeadline(value, policy) > at) return value;
            const next = { ...value, purging: true, purgeBefore: value.purgeBefore || at, revision: value.revision + 1, updatedAt: at }; tx.set(wfRef, next); return next;
          });
        }
      }
      const messages = await page(doc.ref.collection('messages'), cursor.messageAfter), deletedBefore = stats.deletedMessages;
      for (const message of messages) {
        const value = message.data(); stats.messages++;
        if (messageDue(value, p, at)) stats.messagesDue++;
        if (messageDue(value, p, at + 7 * DAY)) stats.messagesIn7Days++;
        if (retentionActive(p, at) && (messageDue(value, p, at) || wf?.purging || !value.attachmentExpired && (value.attachment && attachmentDue(value.attachment, p, at) || ['image', 'audio', 'file'].includes(value.type) && value.sentAt + p.attachmentDays * DAY <= at))) await expireMessage(message.ref, wfRef, uid, at, p, stats);
      }
      const repair = !!cursor.repair || stats.deletedMessages > deletedBefore;
      if (messages.length === 100) return { cursor: { phaseIndex: index, current: doc.id, messageAfter: messages.at(-1).id, repair }, stats };
      if (retentionActive(p, at)) {
        if (repair || wf?.purging) await repairPreview(doc.ref);
        if (wf?.purging) await db.runTransaction(async tx => {
          const [w, current] = await tx.getAll(wfRef, doc.ref); const value = w.data();
          if (!value?.purging || !value.trashed) return;
          const next = { ...value, purging: false, trashed: false, completed: false, purgedAt: value.purgeBefore, revision: value.revision + 1, updatedAt: at }; tx.set(wfRef, next);
          if (current.exists) tx.set(doc.ref, { retentionPurgedAt: value.purgeBefore, lastText: '', lastMessageId: '' }, { merge: true });
          // Keep customer identity/tags/notes; only conversation content is purged.
        });
      }
      return { cursor: { phaseIndex: index, after: doc.id }, stats };
    }
    if (phase === 'workflow') {
      const docs = await page(ctx.account.collection('conversationWorkflow'), cursor.after);
      for (const doc of docs) {
        const value = doc.data(), social = /^(facebook|instagram)-([a-f0-9]{64})$/.exec(value.id), collection = social ? ctx.account.collection('zernioConversations') : ctx.channel?.collection('conversations');
        if (collection && (await collection.doc(social ? social[2] : value.id).get()).exists) continue;
        const deadline = trashDeadline(value, p); if (!deadline) continue;
        if (deadline <= at) stats.trashDue++; if (deadline <= at + 7 * DAY) stats.trashIn7Days++;
        if (retentionActive(p, at) && deadline <= at) await db.runTransaction(async tx => {
          const [w, current] = await tx.getAll(doc.ref, policyRef(uid)); const v = w.data(), policy = current.data();
          if (!v?.trashed || !retentionActive(policy, at) || trashDeadline(v, policy) > at) return;
          tx.set(doc.ref, { ...v, trashed: false, completed: false, purgedAt: at, revision: v.revision + 1, updatedAt: at }); stats.deletedRecords++;
        });
      }
      return docs.length === 100 ? { cursor: { phaseIndex: index, after: docs.at(-1).id }, stats } : advance();
    }
    let collection;
    if (phase === 'lineAttachments') collection = ctx.channel?.collection('attachments');
    else if (phase === 'socialAttachments') collection = state.collection('socialAttachments').where('ownerUid', '==', uid);
    else if (phase === 'lineOutbox') collection = ctx.channel?.collection('outbox');
    else if (phase === 'socialOutbox') collection = ctx.account.collection('socialAttachmentOutbox');
    else if (phase === 'lineReceipts') collection = ctx.channel?.collection('receipts');
    else if (phase === 'socialReceipts') collection = ctx.account.collection('zernioReceipts');
    else collection = ctx.account.collection('aiLogs');
    if (!collection) return advance();
    const docs = await page(collection, cursor.after);
    for (const doc of docs) {
      const value = doc.data(), file = phase.endsWith('Attachments');
      if (file && !value.retentionDeletedAt) {
        stats.files++; stats.fileBytes += value.size || 0;
        if (attachmentDue(value, p, at)) stats.filesDue++;
        if (attachmentDue(value, p, at + 7 * DAY)) stats.filesIn7Days++;
      }
      if (!retentionActive(p, at)) continue;
      if (file) {
        const rawId = phase === 'lineAttachments' ? value.conversationId : `${value.platform}-${hash(`${value.accountId}:${value.conversationId}`)}`;
        const wf = rawId ? (await workflowRef(ctx.account, rawId).get()).data() : null;
        const trashCutoff = wf?.purgedAt || wf?.lastPurgedAt || (wf?.purging ? wf.purgeBefore : 0);
        if (!value.retentionDeletedAt && (attachmentDue(value, p, at) || trashCutoff && attachmentCreated(value) <= trashCutoff)) {
          const currentPolicy = (await policyRef(uid).get()).data(); if (!retentionActive(currentPolicy, now())) continue;
          if (await deleteObject(value.storagePath, ctx, value, uid)) stats.deletedFiles++;
          await doc.ref.delete(); stats.deletedRecords++;
        }
        // Compatibility with previously expired metadata; message placeholders remain.
        if (value.retentionDeletedAt && attachmentCreated(value) + p.textDays * DAY <= at) { await doc.ref.delete(); stats.deletedRecords++; }
      } else {
        const created = value.createdAt ?? value.receivedAt ?? value.message?.sentAt;
        let trash = false;
        if ((phase.endsWith('Outbox') || phase === 'aiLogs') && value.conversationId) {
          const id = phase === 'lineOutbox' || phase === 'aiLogs' && value.provider === 'line' ? value.conversationId : phase === 'aiLogs' ? `${value.provider}-${value.conversationId}` : `${value.platform || 'facebook'}-${hash(`${value.accountId}:${value.conversationId}`)}`;
          const wf = (await workflowRef(ctx.account, id).get()).data(), cutoff = wf?.purgedAt || wf?.lastPurgedAt;
          trash = !!cutoff && Number.isFinite(created) && created <= cutoff;
        }
        if (Number.isFinite(created) && created + p.textDays * DAY <= at || trash) { await doc.ref.delete(); stats.deletedRecords++; }
        else if (phase.endsWith('Outbox') && Number.isFinite(created) && created + p.attachmentDays * DAY <= at && (value.message?.attachment?.url || value.lineMessages?.length)) {
          await doc.ref.set({ ...value, ...(value.message ? { message: { ...safeMessage(value.message.id, value.message), attachmentExpired: true } } : {}), ...(value.lineMessages ? { lineMessages: [] } : {}) }); stats.deletedRecords++;
        }
      }
    }
    return docs.length === 100 ? { cursor: { phaseIndex: index, after: docs.at(-1).id }, stats } : advance();
  }
  async function processJob(uid, jobId, budgetMs = 420000) {
    const ref = jobs(uid).doc(jobId), at = now(), leaseId = randomUUID();
    const claimed = await db.runTransaction(async tx => {
      const j = (await tx.get(ref)).data(); if (j?.type === 'export') {
        if (['queued', 'working'].includes(j.status)) tx.set(ref, { status: 'cancelled', leaseUntil: 0, updatedAt: at }, { merge: true });
        return false;
      }
      if (!j || !['queued', 'working'].includes(j.status) || j.leaseUntil > at || j.expiresAt <= at) return false;
      const failures = (j.failures || 0) + (j.leaseUntil > 0 && j.leaseUntil <= at ? 1 : 0);
      if (failures >= 3) { tx.set(ref, { status: 'failed', failures, errorCode: 'PROCESSING_TIMEOUT', leaseUntil: 0, updatedAt: at }, { merge: true }); return false; }
      tx.set(ref, { status: 'working', leaseId, leaseUntil: at + budgetMs + 60000, attempts: (j.attempts || 0) + 1, failures }, { merge: true }); return true;
    });
    if (!claimed) return;
    try {
      const ctx = await context(uid); const started = Date.now(); let steps = 0;
      while (Date.now() - started < budgetMs && steps++ < 2500) {
        const job = (await ref.get()).data(); if (job.leaseId !== leaseId || job.expiresAt <= now()) break;
        const patch = await scanStep(uid, job, ctx);
        // Replace each checkpoint map; recursive merge retains stale pagination fields.
        const checkpoint = { ...patch, updatedAt: now() };
        await ref.set(checkpoint, { mergeFields: Object.keys(checkpoint) });
        if (patch.status) break;
      }
      await ref.set({ leaseUntil: 0 }, { merge: true });
    } catch (error) {
      const j = (await ref.get()).data(), failures = (j.failures || 0) + 1; await ref.set({ leaseUntil: 0, failures, status: failures >= 3 ? 'failed' : 'queued', errorCode: 'PROCESSING_FAILED', updatedAt: now() }, { merge: true });
      throw error;
    }
  }
  async function expireBackup(uid, doc) {
    if (doc.data().type !== 'export') { await doc.ref.delete(); return; }
    const prefix = objectPrefix(uid, doc.id), [files] = await bucket.getFiles({ prefix, maxResults: 100, autoPaginate: false });
    for (const file of files) { const [meta] = await file.getMetadata(); await file.delete({ ifGenerationMatch: meta.generation, ignoreNotFound: true }); }
    if (files.length === 100) return;
    if (doc.data().expiresAt + 23 * DAY <= now()) await doc.ref.delete();
    else await doc.ref.set({ status: 'expired', parts: 0, cursor: {}, stats: {} }, { merge: true });
  }
  async function scheduled() {
    const control = state.collection('retention').doc('scheduler'), at = now(), leaseId = randomUUID();
    const checkpoint = await db.runTransaction(async tx => { const old = (await tx.get(control)).data() || {}; if (old.leaseUntil > at) return null; tx.set(control, { ...old, leaseId, leaseUntil: at + 9 * 60000 }); return old; });
    if (!checkpoint) return;
    const started = Date.now();
    try {
      const docs = await page(accounts, checkpoint.after, 30);
      for (const doc of docs) {
        if (Date.now() - started > 390000) break;
        const uid = doc.id, p = await ensurePolicy(uid), recent = (await previewRef(uid).get()).data();
        const pending = (await jobs(uid).where('status', 'in', ['queued', 'working']).limit(5).get()).docs;
        if (!pending.some(j => j.data().type === 'scan') && (!recent || p.enabled && recent.finishedAt < now() - DAY || recent.policyRevision !== p.revision)) await queue(uid, 'scan');
        for (const j of pending) { if (Date.now() - started > 390000) break; try { await processJob(uid, j.id, Math.min(60000, 420000 - (Date.now() - started))); } catch { /* Status contains a safe failure code; next run retries. */ } }
        for (const j of (await jobs(uid).where('expiresAt', '<=', now()).limit(20).get()).docs) await expireBackup(uid, j);
        await control.set({ after: doc.id }, { merge: true });
      }
      if (docs.length < 30 && Date.now() - started < 390000) await control.set({ after: null }, { merge: true });
    } finally { await control.set({ leaseUntil: 0, lastRunAt: now() }, { merge: true }); }
  }
  return { ensurePolicy, summary, queue, processJob, scheduled, policyRef, previewRef, jobs, context, scanStep, objectPrefix };
}
