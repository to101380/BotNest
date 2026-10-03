import test from 'node:test';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { memoryDb } from '../functions/test/memory.js';
import { createRetentionService } from '../functions/data-retention.js';
import { createRetentionHandler } from '../functions/retention-api.js';
import { createWorkflowStore, cleanWorkflow, reopenedWorkflow } from '../functions/conversation-workflow.js';
import { initialPolicy, DAY, validateRetention, trashDeadline } from '../functions/retention-policy.js';
import { createStore } from '../functions/store.js';
import { visibleRetainedMessage } from '../functions/retention-policy.js';


function fakeBucket() {
  const data = new Map(); const file = path => ({ name: path, createWriteStream: () => { const chunks = []; return new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); }, final(done) { data.set(path, Buffer.concat(chunks)); done(); } }); }, getSignedUrl: async () => ['https://storage.googleapis.com/test'], save: async bytes => data.set(path, Buffer.from(bytes)), getMetadata: async () => { if (!data.has(path)) throw Object.assign(Error('missing'), { code: 404 }); return [{ size: data.get(path).length, generation: '1' }]; }, download: async () => { if (!data.has(path)) throw Object.assign(Error('missing'), { code: 404 }); return [data.get(path)]; }, delete: async options => { assert.equal(options.ifGenerationMatch, '1'); data.delete(path); } });
  return { data, file, getFiles: async ({ prefix, maxResults }) => [[...data.keys()].filter(p => p.startsWith(prefix)).slice(0, maxResults).map(file)] };
}
async function fixture(enabled = false) {
  const db = memoryDb(), bucket = fakeBucket(); let at = Date.now();
  const service = createRetentionService({ db, bucket, now: () => at });
  const root = db.collection('botnest').doc('state'), account = root.collection('accounts').doc('alice'), channel = root.collection('channels').doc('123');
  await account.set({ channelId: '123' }); await channel.set({ ownerUid: 'alice' });
  const p = { ...initialPolicy(at - 40 * DAY), enabled }; await service.policyRef('alice').set(p);
  return { db, bucket, service, account, channel, now: () => at, tick: n => at += n };
}


test('retention requires current inventory and explicit confirmation, always grants 14 days', () => {
  const at = 100 * DAY, old = initialPolicy(at - 10 * DAY), body = { ...old, enabled: true, confirm: true };
  const input = { textDays: 365, attachmentDays: 90, trashDays: 30, enabled: true, revision: 0, confirm: true };
  assert.throws(() => validateRetention(input, old, null, at));
  assert.throws(() => validateRetention({ ...input, confirm: false }, old, { finishedAt: at, policyRevision: 0 }, at));
  assert.equal(validateRetention(input, old, { finishedAt: at, policyRevision: 0 }, at).effectiveAt, at + 14 * DAY);
  assert.throws(() => validateRetention({ ...input, textDays: 1 }, old, { finishedAt: at, policyRevision: 0 }, at));
  assert.equal(trashDeadline({ trashed: true }, old), old.preparedAt + 30 * DAY);
});
test('preview never deletes, active retention deletes old text/files and keeps recent messages/customer', async () => {
  const f = await fixture(), conv = f.channel.collection('conversations').doc('c');
  await conv.set({ customer: { name: 'Alice', notes: ['keep'] }, updatedAt: f.now() - 400 * DAY, lastMessageId: 'old', lastText: 'old' });
  await conv.collection('messages').doc('old').set({ text: 'old', direction: 'incoming', sentAt: f.now() - 400 * DAY });
  await conv.collection('messages').doc('recent').set({ text: 'recent', direction: 'incoming', sentAt: f.now() - DAY });
  await conv.collection('messages').doc('image').set({ text: '[圖片]', type: 'image', sentAt: f.now() - 100 * DAY, attachment: { id: 'file', name: 'demo.png', url: 'SECRET_URL', expiresAt: f.now() - 70 * DAY } });
  await f.channel.collection('attachments').doc('file').set({ conversationId: 'c', storagePath: 'botnest/123/file', name: 'demo.png', kind: 'image', createdAt: f.now() - 100 * DAY, expiresAt: f.now() - 70 * DAY, size: 5 });
  await f.bucket.file('botnest/123/file').save('image');
  const foreign = f.db.collection('botnest').doc('state').collection('channels').doc('foreign').collection('conversations').doc('c').collection('messages').doc('old'); await foreign.set({ text: 'untouched', sentAt: 0 });
  const preview = await f.service.queue('alice', 'scan'); await f.service.processJob('alice', preview, 5000);
  assert.equal((await conv.collection('messages').doc('old').get()).exists, true); assert.equal(f.bucket.data.size, 1);
  await f.service.policyRef('alice').set({ ...(await f.service.ensurePolicy('alice')), enabled: true }); f.tick(60001);
  const cleanup = await f.service.queue('alice', 'scan'); await f.service.processJob('alice', cleanup, 5000);
  assert.equal((await conv.collection('messages').doc('old').get()).exists, false); assert.equal((await conv.collection('messages').doc('recent').get()).exists, true);
  assert.equal((await conv.collection('messages').doc('image').get()).data().attachmentExpired, true); assert.equal(f.bucket.data.size, 0);
  assert.equal((await conv.get()).data().lastText, 'recent'); assert.deepEqual((await conv.get()).data().customer.notes, ['keep']); assert.equal((await foreign.get()).exists, true);
  assert.equal((await f.service.summary('alice')).preview.deletedMessages, 1);
});
test('trash purge is account scoped, blocks mid-purge restore, and new incoming restores trash', async () => {
  const f = await fixture(true), conv = f.channel.collection('conversations').doc('c'), workflow = createWorkflowStore(f.db);
  await conv.set({ customer: { name: 'keep' }, lastText: 'hello', updatedAt: f.now() - 50 * DAY });
  await conv.collection('messages').doc('m').set({ text: 'hello', sentAt: f.now() - 50 * DAY });
  await workflow.save('alice', cleanWorkflow({ id: 'c', action: 'trash', value: true, revision: 0 }, 'alice'), f.now() - 31 * DAY);
  const id = await f.service.queue('alice', 'scan'); await f.service.processJob('alice', id, 5000);
  assert.equal((await conv.collection('messages').doc('m').get()).exists, false); assert.equal((await conv.get()).data().customer.name, 'keep');
  assert.equal((await createStore(f.db).conversations('123')).items.length, 0);
  assert.equal((await createStore(f.db).conversations('123', null, true)).items[0].customer.name, 'keep');
  const state = (await workflow.list('alice'))[0]; assert.ok(state.purgedAt); assert.equal(state.trashed, false);
  assert.equal(reopenedWorkflow(state, f.now() - DAY), null);
  assert.equal(reopenedWorkflow(state, f.now() + 1).purgedAt, 0);
  const pending = reopenedWorkflow({ trashed: true, trashedAt: 1, revision: 1 }, 2); assert.equal(pending.trashed, false);
});

test('media reads cannot refetch retained-out messages and attachments', async () => {
  const f = await fixture(true), store = createStore(f.db);
  const messages = await store.retainedMessages('alice', 'c', [{ id: 'old', sentAt: f.now() - 400 * DAY, text: 'old' }, { id: 'image', sentAt: f.now() - 100 * DAY, type: 'image', attachment: { url: 'secret', name: 'image.png' } }], f.now());
  assert.equal(messages.length, 1); assert.equal(messages[0].attachment.url, ''); assert.equal(messages[0].attachmentExpired, true);
});
test('new message during paginated trash cleanup cancels purge and preserves new conversation preview', async () => {
  const f = await fixture(true), conv = f.channel.collection('conversations').doc('c'), workflow = createWorkflowStore(f.db);
  await conv.set({ updatedAt: f.now() - DAY, lastMessageId: 'old', lastText: 'old' });
  for (let i = 0; i < 101; i++) await conv.collection('messages').doc(String(i).padStart(3, '0')).set({ text: 'old', sentAt: f.now() - DAY });
  await workflow.save('alice', cleanWorkflow({ id: 'c', action: 'trash', value: true, revision: 0 }, 'alice'), f.now() - 31 * DAY);
  const ctx = await f.service.context('alice'), patch = await f.service.scanStep('alice', { policyRevision: 0, cursor: {}, stats: {} }, ctx);
  await createStore(f.db).ingest('123', { conversationId: 'c', messageId: 'new', eventId: 'new', type: 'text', text: 'new contact', sentAt: f.now() + 1, sourceType: 'user', sourceId: 'u' });
  await f.service.scanStep('alice', { policyRevision: 0, ...patch }, ctx);
  assert.equal((await conv.collection('messages').doc('new').get()).exists, true);
  assert.equal((await conv.get()).data().lastText, 'new contact'); assert.equal((await workflow.list('alice'))[0].trashed, false);
});
test('old provider history stays hidden after a purged conversation receives new messages', () => {
  const state = reopenedWorkflow({ purgedAt: 100, revision: 2 }, 101);
  assert.equal(state.purgedAt, 0); assert.equal(visibleRetainedMessage({ sentAt: 99 }, null, state, 200), false); assert.equal(visibleRetainedMessage({ sentAt: 101 }, null, state, 200), true);
});
test('unpersisted social conversations are purged through workflow and remain tenant scoped', async () => {
  const f = await fixture(true), id = `instagram-${'a'.repeat(64)}`, workflow = createWorkflowStore(f.db);
  await workflow.save('alice', cleanWorkflow({ id, action: 'trash', value: true, revision: 0 }, 'alice'), f.now() - 31 * DAY);
  const job = await f.service.queue('alice', 'scan'); await f.service.processJob('alice', job, 5000);
  assert.ok((await workflow.list('alice'))[0].purgedAt); assert.equal((await workflow.list('bob')).length, 0);
});
test('grace period and paused policies never delete even already expired data', async () => {
  const f = await fixture(true), conv = f.channel.collection('conversations').doc('c'); await conv.set({ lastText: 'old' }); await conv.collection('messages').doc('m').set({ text: 'old', sentAt: 1 });
  await f.service.policyRef('alice').set({ ...(await f.service.ensurePolicy('alice')), effectiveAt: f.now() + DAY });
  const job = await f.service.queue('alice', 'scan'); await f.service.processJob('alice', job, 5000); assert.equal((await conv.collection('messages').doc('m').get()).exists, true);
});

test('repeated crashed workers stop after three failures instead of retrying forever', async () => {
  const f = await fixture(), id = await f.service.queue('alice', 'scan'), ref = f.service.jobs('alice').doc(id);
  await ref.set({ status: 'working', leaseUntil: f.now() - 1, failures: 2 }, { merge: true });
  await f.service.processJob('alice', id, 1000);
  assert.equal((await ref.get()).data().status, 'failed'); assert.equal((await ref.get()).data().failures, 3); assert.equal(f.bucket.data.size, 0);
});









test('removed backup APIs cannot create or download jobs; retention scans still work', async () => {
  const f = await fixture(), handler = createRetentionHandler({ service: f.service, now: f.now, accountStore: createStore(f.db), verifyToken: async uid => ({ uid, firebase: { sign_in_provider: 'google.com' } }) });
  async function call(path, method) {
    let code = 200, body;
    await handler({ method, url: '/api/ai/retention' + path, body: {}, get: name => name === 'authorization' ? 'Bearer alice' : name === 'origin' ? 'https://planning-with-ai-52d58.web.app' : undefined }, { set() {}, status(n) { code = n; return this; }, json(value) { body = value; } });
    return { code, body };
  }
  for (const [path, method] of [['/export', 'POST'], ['/package', 'POST'], ['/download?id=old&volume=1', 'GET']]) assert.equal((await call(path, method)).code, 404);
  assert.equal((await f.service.jobs('alice').orderBy('createdAt').get()).docs.length, 0);
  await assert.rejects(f.service.queue('alice', 'export'), { status: 404 });
  assert.equal((await call('/scan', 'POST')).code, 202);
  assert.equal((await call('', 'GET')).body.jobs.length, 1);
});

test('legacy backup jobs stop generating while existing archives expire on their original schedule', async () => {
  const f = await fixture(), ref = f.service.jobs('alice').doc('legacy');
  await ref.set({ type: 'export', status: 'queued', createdAt: f.now(), expiresAt: f.now() + 7 * DAY, cursor: {} });
  const path = f.service.objectPrefix('alice', ref.id) + 'part-000001.zip'; await f.bucket.file(path).save(Buffer.from('existing archive'));
  await f.service.processJob('alice', ref.id);
  assert.equal((await ref.get()).data().status, 'cancelled');
  assert.equal((await f.service.summary('alice')).jobs.length, 0);
  await f.service.scheduled(); assert.equal(f.bucket.data.has(path), true);
  f.tick(8 * DAY); await f.service.scheduled(); assert.equal(f.bucket.data.has(path), false);
});
