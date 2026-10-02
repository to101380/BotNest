import test from 'node:test';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { memoryDb } from '../functions/test/memory.js';
import { createRetentionService } from '../functions/data-retention.js';
import { createRetentionHandler } from '../functions/retention-api.js';
import { createWorkflowStore, cleanWorkflow, reopenedWorkflow } from '../functions/conversation-workflow.js';
import { initialPolicy, DAY, validateRetention, trashDeadline } from '../functions/retention-policy.js';
import { createStore } from '../functions/store.js';
import { visibleRetainedMessage } from '../functions/retention-policy.js';
const JSZip = createRequire(new URL('../functions/package.json', import.meta.url))('jszip');

test('backup reads share the API rate budget and downloads have an additional per-account cap', async () => {
  const f = await fixture(), accountStore = createStore(f.db);
  const handler = createRetentionHandler({ service: f.service, bucket: f.bucket, now: f.now, accountStore, verifyToken: async uid => ({ uid, firebase: { sign_in_provider: 'google.com' } }) });
  async function call(uid, url = '/api/ai/retention') {
    let code = 200;
    await handler({ method: 'GET', url, get: name => name === 'authorization' ? `Bearer ${uid}` : undefined }, { set() {}, status(n) { code = n; return this; }, json() {}, send() {} });
    return code;
  }
  for (let i = 0; i < 120; i++) assert.equal(await call('alice'), 200);
  assert.equal(await call('alice'), 429); assert.equal(await call('bob'), 200);
  f.tick(60000); assert.equal(await call('alice'), 200);
  for (let i = 0; i < 20; i++) assert.equal(await call('alice', '/api/ai/retention/download?id=invalid&part=1'), 400);
  assert.equal(await call('alice', '/api/ai/retention/download?id=invalid&part=1'), 429);
});
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

test('exports reuse matching active jobs but allow immediate retry after completion/failure/expiry', async () => {
  const f = await fixture();
  const first = await f.service.queue('alice', 'export', 'one');
  assert.equal(await f.service.queue('alice', 'export', 'one'), first);
  await assert.rejects(f.service.queue('alice', 'export', 'two'), e => e.status === 429);
  for (const status of ['ready', 'failed', 'cancelled', 'expired']) {
    await f.service.jobs('alice').doc(first).set({ status }, { merge: true });
    const retry = await f.service.queue('alice', 'export', 'one');
    assert.notEqual(retry, first);
    await f.service.jobs('alice').doc(retry).set({ status: 'ready' }, { merge: true });
  }
  const active = await f.service.queue('alice', 'export', 'one');
  await f.service.jobs('alice').doc(active).set({ expiresAt: f.now() - 1 }, { merge: true });
  assert.notEqual(await f.service.queue('alice', 'export', 'one'), active);
});
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
test('large exports paginate without losing messages, sanitize secrets, ZIP HTML is safe and expires', async () => {
  const f = await fixture(), conv = f.channel.collection('conversations').doc('c'); await conv.set({ displayName: '<script>bad</script>' });
  for (let i = 0; i < 205; i++) await conv.collection('messages').doc(String(i).padStart(4, '0')).set({ text: i === 0 ? '=HYPERLINK("bad")<script>' : `m${i}`, sentAt: f.now() - DAY, direction: 'incoming', replyToken: 'SECRET_REPLY_TOKEN', audioTicket: 'SECRET_TICKET' });
  const id = await f.service.queue('alice', 'export'); await f.service.processJob('alice', id, 5000); const job = (await f.service.jobs('alice').doc(id).get()).data();
  assert.equal(job.status, 'ready'); assert.equal(job.messages, 205); assert.equal(job.parts, 3);
  for (const [name, bytes] of f.bucket.data) if (name.includes("/part-")) { const zip = await JSZip.loadAsync(bytes), html = await zip.file('conversation.html').async('string'), json = await zip.file('messages.json').async('string'); assert.ok(!html.includes('<script>')); assert.ok(!json.includes('SECRET_')); }
  const handler = createRetentionHandler({ service: f.service, bucket: f.bucket, now: f.now, verifyToken: async token => token === 'alice' ? { uid: 'alice', firebase: { sign_in_provider: 'google.com' } } : { uid: 'bob', firebase: { sign_in_provider: 'google.com' } }, accountStore: createStore(f.db) });
  async function call(token) { let code = 200, body; await handler({ method: 'GET', url: `/api/ai/retention/download?id=${id}&part=1`, get: () => `Bearer ${token}` }, { set() {}, status(n) { code = n; return this; }, json(v) { body = v; }, send(v) { body = v; } }); return { code, body }; }
  assert.equal((await call('bob')).code, 404); assert.equal((await call('alice')).code, 200); f.tick(7 * DAY); assert.equal((await call('alice')).code, 404);
  await f.service.scheduled(); assert.equal(f.bucket.data.size, 0);
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
test('remote exports filter foreign accounts and include paginated outgoing/incoming messages', async () => {
  const f = await fixture(), accountId = 'social-a'; await f.account.set({ channelId: '123', zernio: { facebook: { accountId } } });
  const service = createRetentionService({ db: f.db, bucket: f.bucket, now: f.now, socialReader: async path => {
    if (!path.includes('/messages?')) return { data: [{ id: 'thread', accountId, platform: 'facebook', participantName: 'Demo' }], pagination: { hasMore: false } };
    const second = path.includes('&cursor=next'); return { messages: [{ id: second ? 'incoming' : 'outgoing', accountId, conversationId: 'thread', direction: second ? 'incoming' : 'outgoing', message: 'hello', createdAt: new Date(f.now() - DAY).toISOString() }, { id: 'foreign', accountId: 'someone-else', conversationId: 'thread', message: 'SECRET_OTHER_ACCOUNT', createdAt: new Date(f.now() - DAY).toISOString() }], pagination: { hasMore: !second, nextCursor: second ? null : 'next' } };
  } });
  const id = await service.queue('alice', 'export'); await service.processJob('alice', id, 5000); const job = (await service.jobs('alice').doc(id).get()).data(); assert.equal(job.messages, 2); assert.equal(job.parts, 2);
  for (const [name, bytes] of f.bucket.data) if (name.includes("/part-")) { const zip = await JSZip.loadAsync(bytes); assert.ok(!(await zip.file('messages.json').async('string')).includes('SECRET_OTHER_ACCOUNT')); }
});
test('repeated crashed workers stop after three failures instead of retrying forever', async () => {
  const f = await fixture(), id = await f.service.queue('alice', 'export'), ref = f.service.jobs('alice').doc(id);
  await ref.set({ status: 'working', leaseUntil: f.now() - 1, failures: 2 }, { merge: true });
  await f.service.processJob('alice', id, 1000);
  assert.equal((await ref.get()).data().status, 'failed'); assert.equal((await ref.get()).data().failures, 3); assert.equal(f.bucket.data.size, 0);
});

test('complete backup merges batches into one readable archive with intact attachments and CRC', async () => {
  const f = await fixture(), conv = f.channel.collection('conversations').doc('full');
  await conv.set({ displayName: '完整對話' });
  for (let i = 0; i < 205; i++) await conv.collection('messages').doc(String(i).padStart(4, '0')).set({ text: `內容 ${i}`, sentAt: f.now() - DAY });
  const id = await f.service.queue('alice', 'export'); await f.service.processJob('alice', id, 5000);
  const job = (await f.service.jobs('alice').doc(id).get()).data(); assert.equal(job.downloadFiles.length, 1);
  const bytes = f.bucket.data.get(f.service.objectPrefix('alice', id) + job.downloadFiles[0].name);
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  assert.ok(await archive.file('index.html').async('string')); assert.ok(archive.file('README.txt'));
  let count = 0; for (const name of Object.keys(archive.files).filter(n => n.endsWith('/messages.json'))) count += JSON.parse(await archive.file(name).async('string')).messages.length;
  assert.equal(count, 205); assert.equal(Object.keys(archive.files).filter(n => n.endsWith('.zip')).length, 0);
});

test('legacy backups are repackaged once without refetching conversation history or extending expiration', async () => {
  const f = await fixture(), conv = f.channel.collection('conversations').doc('legacy'); await conv.set({});
  await conv.collection('messages').doc('m').set({ text: '保留原始內容', sentAt: f.now() - DAY });
  const id = await f.service.queue('alice', 'export'); await f.service.processJob('alice', id, 5000);
  const original = (await f.service.jobs('alice').doc(id).get()).data(); await f.service.jobs('alice').doc(id).set({ downloadFiles: [] }, { merge: true });
  await conv.collection('messages').doc('m').set({ text: '之後變更', sentAt: f.now() });
  const next = await f.service.prepareDownload('alice', id); assert.equal(await f.service.prepareDownload('alice', id), next);
  await assert.rejects(f.service.prepareDownload('bob', id), e => e.status === 404);
  await f.service.processJob('alice', next, 5000); const job = (await f.service.jobs('alice').doc(next).get()).data();
  assert.equal(job.status, 'ready'); assert.equal(job.expiresAt, original.expiresAt);
  const archive = await JSZip.loadAsync(f.bucket.data.get(f.service.objectPrefix('alice', next) + job.downloadFiles[0].name), { checkCRC32: true });
  const text = await archive.file('conversations/000001/messages.json').async('string'); assert.ok(text.includes('保留原始內容')); assert.ok(!text.includes('之後變更'));
  let code = 200, body;
  const handler = createRetentionHandler({ service: f.service, bucket: f.bucket, now: f.now, verifyToken: async () => ({ uid: 'alice', firebase: { sign_in_provider: 'google.com' } }), accountStore: createStore(f.db) });
  await handler({ method: 'GET', url: `/api/ai/retention/download?id=${next}&volume=1`, get: name => name === 'authorization' ? 'Bearer alice' : undefined }, { set() {}, status(n) { code = n; return this; }, json(v) { body = v; } });
  assert.equal(code, 200); assert.match(body.downloadUrl, /^https:/); assert.equal(body.expiresAt, f.now() + 300000);
  f.tick(7 * DAY); await assert.rejects(f.service.prepareDownload('alice', id), e => e.status === 404);
});

import { zipFiles } from '../functions/backup-zip.js';
import { downloadPlan, streamBackup } from '../functions/backup-download.js';
test('download packaging splits by bytes, preserves attachments and rejects unsafe archive paths', async () => {
  const sizes = Array.from({ length: 5 }, (_, i) => ({ name: `p/part-${String(i + 1).padStart(6, '0')}.zip`, metadata: { size: 25 * 1048576 } }));
  const plan = await downloadPlan({ getFiles: async () => [sizes] }, 'p/', { parts: 5 }); assert.deepEqual(plan.map(v => v.parts.length), [4, 1]);
  const original = zipFiles([['conversation.html', '<a href="attachments/image.png">圖片</a>'], ['attachments/image.png', Buffer.from([1, 2, 3, 4])]]);
  const chunks = []; for await (const chunk of streamBackup({ file: () => ({ download: async () => [original] }) }, 'p/', { messages: 1, createdAt: Date.now() }, { parts: [1] }, 1, 1)) chunks.push(chunk);
  const archive = await JSZip.loadAsync(Buffer.concat(chunks), { checkCRC32: true }); assert.deepEqual(await archive.file('conversations/000001/attachments/image.png').async('nodebuffer'), Buffer.from([1, 2, 3, 4]));
  const unsafe = zipFiles([['../unsafe.html', 'bad']]);
  await assert.rejects(async () => { for await (const chunk of streamBackup({ file: () => ({ download: async () => [unsafe] }) }, 'p/', { createdAt: Date.now() }, { parts: [1] }, 1, 1)) {} });
});

test('signed backup downloads reject other tenants, expiry and unsafe filenames before signing', async () => {
  const f = await fixture(), id = await f.service.queue('alice', 'export'), ref = f.service.jobs('alice').doc(id);
  await ref.set({ status: 'ready', downloadFiles: [{ name: 'backup-0001.zip', bytes: 100 }] }, { merge: true });
  let signatures = 0; const file = f.bucket.file;
  f.bucket.file = name => ({ ...file(name), getSignedUrl: async () => { signatures++; return ['https://storage.googleapis.com/test']; } });
  const handler = createRetentionHandler({ service: f.service, bucket: f.bucket, now: f.now, accountStore: createStore(f.db), verifyToken: async uid => ({ uid, firebase: { sign_in_provider: 'google.com' } }) });
  async function call(uid, volume = '1') { let code = 200; await handler({ method: 'GET', url: `/api/ai/retention/download?id=${id}&volume=${volume}`, get: name => name === 'authorization' ? `Bearer ${uid}` : undefined }, { set() {}, status(n) { code = n; return this; }, json() {} }); return code; }
  assert.equal(await call('bob'), 404); assert.equal(await call('alice', '0'), 400); assert.equal(await call('alice', '2'), 404); assert.equal(signatures, 0);
  assert.equal(await call('alice'), 200); assert.equal(signatures, 1);
  await ref.set({ downloadFiles: [{ name: '../private.zip', bytes: 100 }] }, { merge: true }); assert.equal(await call('alice'), 404); assert.equal(signatures, 1);
  await ref.set({ downloadFiles: [{ name: 'backup-0001.zip', bytes: 100 }], expiresAt: f.now() }, { merge: true }); assert.equal(await call('alice'), 404); assert.equal(signatures, 1);
});
