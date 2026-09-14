import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHmac, randomUUID } from "node:crypto";
import { createHandler, seal, unseal, validSignature, normalizeEvent } from "../core.js";
import { createStore } from "../store.js";
import { memoryDb } from "./memory.js";
import { validateUpload } from "../media.js";

const key = randomBytes(32).toString("base64"), secret = "a".repeat(32), botId = `U${"b".repeat(32)}`;
const event = (id = "1", timestamp = 1000) => ({ type: "message", webhookEventId: `event-${id}`, timestamp, source: { type: "user", userId: `U${"c".repeat(32)}` }, message: { id, type: "text", text: `message ${id}` } });
const channel = (id = "1234567890", uid = "alice") => ({ channelId: id, ownerUid: uid, botUserId: botId, displayName: "Test OA", basicId: "@test", secret: seal(secret, key, id), accessToken: seal("test-access-token", key, `${id}:access-token`) });
async function fixture(overrides = {}) {
  const db = memoryDb(), store = createStore(db);
  await store.bind("alice", channel());
  await store.bind("bob", channel("9876543210", "bob"));
  const handler = createHandler({ store, getKey: () => key, now: () => 1000000, fetchLine: async () => { throw new Error("Test must explicitly mock LINE"); },
    verifyToken: async token => { if (!["alice", "bob"].includes(token)) throw new Error("invalid"); return { uid: token, auth_time: 1000, firebase: { sign_in_provider: "google.com" } }; }, ...overrides });
  async function request(url, { token = "alice", method = "GET", body, raw, headers = {} } = {}) {
    const allHeaders = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } };
    await handler({ originalUrl: url, method, body, rawBody: raw, get: name => allHeaders[name.toLowerCase()] }, res);
    return res;
  }
  async function webhook(events, extras = {}) {
    const raw = Buffer.from(JSON.stringify({ destination: botId, events }));
    return request("/line-webhook/1234567890", { method: "POST", token: null, raw, headers: { "x-line-signature": createHmac("sha256", secret).update(raw).digest("base64") }, ...extras });
  }
  return { db, store, request, webhook };
}

test("OA secrets are authenticated ciphertext bound to their channel", () => {
  const value = seal(secret, key, "1234567890");
  assert.equal(unseal(value, key, "1234567890"), secret);
  assert.throws(() => unseal(value, key, "other-channel"));
  assert.throws(() => unseal({ ...value, data: Buffer.from("tampered").toString("base64") }, key, "1234567890"));
  assert.ok(!JSON.stringify(value).includes(secret));
});
test("signature validates exact raw bytes, rejecting altered bodies and malformed signatures", () => {
  const raw = Buffer.from('{"events":[]}');
  const signature = createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(validSignature(raw, signature, secret), true);
  for (const invalid of ["", "AAAA", signature.slice(1)]) assert.equal(validSignature(raw, invalid, secret), false);
  assert.equal(validSignature(Buffer.from('{ "events": [] }'), signature, secret), false);
});
test("webhook Verify empty events succeeds only with a valid signature and destination", async () => {
  const f = await fixture();
  assert.equal((await f.webhook([])).code, 200);
  assert.equal((await f.store.getChannel("1234567890")).verifiedAt, 1000000);
  assert.equal((await f.webhook([], { headers: {} })).code, 401);
  const raw = Buffer.from(JSON.stringify({ destination: "other", events: [] }));
  assert.equal((await f.webhook([], { raw, headers: { "x-line-signature": createHmac("sha256", secret).update(raw).digest("base64") } })).code, 400);
});
test("webhook delivery is durable, deduplicated, and out-of-order events do not replace latest preview", async () => {
  const f = await fixture();
  const latest = event("2", 2000), oldest = event("1", 1000);
  assert.equal((await f.webhook([latest, latest, oldest])).code, 200);
  const conversations = await f.store.conversations("1234567890");
  assert.equal(conversations.items.length, 1);
  assert.equal(conversations.items[0].lastText, "message 2");
  assert.equal((await f.store.messages("1234567890", conversations.items[0].id)).items.length, 2);
});
test("unsend removes text and preview; redelivery cannot restore it", async () => {
  const f = await fixture(), original = event();
  await f.webhook([original]);
  const unsend = { ...original, type: "unsend", webhookEventId: "unsend-1", unsend: { messageId: "1" } };
  await f.webhook([unsend]); await f.webhook([{ ...original, webhookEventId: "retry-1" }]);
  const conversations = await f.store.conversations("1234567890");
  const messages = await f.store.messages("1234567890", conversations.items[0].id);
  assert.equal(messages.items[0].text, "[訊息已收回]");
  assert.equal(conversations.items[0].lastText, "[訊息已收回]");
});
test("unsend received before a message keeps a tombstone and discards original text", async () => {
  const f = await fixture(), original = event();
  await f.webhook([{ ...original, type: "unsend", webhookEventId: "unsend-first", unsend: { messageId: "1" } }, original]);
  assert.ok(!JSON.stringify([...f.db.data]).includes("message 1"));
});
test("private endpoints require valid authentication", async () => {
  const f = await fixture();
  assert.equal((await f.request("/api/line/account", { token: null })).code, 401);
  assert.equal((await f.request("/api/line/conversations", { token: "expired" })).code, 401);
});
test("anonymous and unverified password accounts cannot access private endpoints", async () => {
  for (const provider of ["anonymous", "password"]) {
    const f = await fixture({ verifyToken: async () => ({ uid: "alice", firebase: { sign_in_provider: provider }, email_verified: false }) });
    assert.equal((await f.request("/api/line/account")).code, 403);
  }
});
test("users cannot select another tenant through query parameters or guessed conversation IDs", async () => {
  const f = await fixture(); await f.webhook([event()]);
  const alice = (await f.request("/api/line/conversations")).body.items[0];
  const bob = await f.request("/api/line/conversations?channelId=1234567890&ownerUid=alice", { token: "bob" });
  assert.deepEqual(bob.body.items, []);
  const guessed = await f.request(`/api/line/conversations/${alice.id}/messages`, { token: "bob" });
  assert.deepEqual(guessed.body.items, []);
});
test("account response never reveals encrypted credentials, token, or owner UID", async () => {
  const f = await fixture();
  const result = await f.request("/api/line/account");
  assert.deepEqual(Object.keys(result.body.channel).sort(), ["channelId", "displayName", "basicId", "webhookUrl", "verifiedAt", "lastReceivedAt", "canReply"].sort());
});
test("binding transaction rejects channel takeover and changing the current OA", async () => {
  const f = await fixture();
  await assert.rejects(f.store.bind("bob", channel("1234567890", "bob")), { status: 409 });
  await assert.rejects(f.store.bind("alice", channel("2222222222")), { status: 409 });
  assert.equal((await f.store.account("alice")).channelId, "1234567890");
});
test("binding throttles repeated requests atomically", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.store.bindingAttempt("alice", 1000)));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 5);
  await f.store.bindingAttempt("alice", 62000);
});
test("binding checks recent login before accepting credentials", async () => {
  const f = await fixture({ verifyToken: async () => ({ uid: "alice", auth_time: 0, firebase: { sign_in_provider: "google.com" } }) });
  assert.equal((await f.request("/api/line/account", { method: "POST", body: {} })).code, 401);
});
test("binding verifies token ownership and encrypts credentials with distinct authenticated contexts", async () => {
  const token = "fake-token-".repeat(10), calls = [];
  const f = await fixture({ fetchLine: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith("/verify") ? { client_id: "1234567890" } : { userId: botId, displayName: "OA" } };
  } });
  const result = await f.request("/api/line/account", { method: "POST", body: { channelId: "1234567890", channelSecret: secret, accessToken: token } });
  assert.equal(result.code, 200); assert.equal(calls.length, 2);
  const persisted = JSON.stringify([...f.db.data]);
  assert.ok(!persisted.includes(token)); assert.ok(!persisted.includes(secret));
  const saved = await f.store.account("alice");
  assert.equal(unseal(saved.accessToken, key, "1234567890:access-token"), token);
  assert.throws(() => unseal(saved.accessToken, key, "1234567890"));
});

const replyPath = () => `/api/line/conversations/${normalizeEvent(event()).conversationId}/messages`;
test("reply uses only the server-owned recipient and records success without resending duplicates", async () => {
  const calls = [];
  const f = await fixture({ fetchLine: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200 }; } });
  await f.webhook([event()]);
  const body = { text: "你好！", operationId: randomUUID(), to: "attacker" };
  const result = await f.request(replyPath(), { method: "POST", body });
  assert.equal(result.code, 200); assert.equal(result.body.message.status, "sent");
  assert.equal(JSON.parse(calls[0].options.body).to, event().source.userId);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-access-token");
  assert.ok(calls[0].options.headers["X-Line-Retry-Key"]);
  await f.request(replyPath(), { method: "POST", body });
  assert.equal(calls.length, 1);
  const list = await f.store.messages("1234567890", normalizeEvent(event()).conversationId);
  assert.equal(list.items.filter(item => item.direction === "outgoing").length, 1);
});
test("reply denies other tenants, anonymous access, blank and oversized payloads, and missing tokens", async () => {
  let calls = 0;
  const f = await fixture({ fetchLine: async () => { calls++; return { ok: true }; } });
  await f.webhook([event()]);
  const body = { text: "reply", operationId: randomUUID() };
  assert.equal((await f.request(replyPath(), { method: "POST", body, token: "bob" })).code, 404);
  assert.equal((await f.request(replyPath(), { method: "POST", body, token: null })).code, 401);
  for (const text of ["  ", "x".repeat(5001)]) assert.equal((await f.request(replyPath(), { method: "POST", body: { ...body, text } })).code, 400);
  assert.equal((await f.request(replyPath(), { method: "POST", body, headers: { origin: "https://evil.example" } })).code, 403);
  delete f.db.data.get("botnest/state/channels/1234567890").accessToken;
  assert.equal((await f.request(replyPath(), { method: "POST", body })).code, 409);
  assert.equal(calls, 0);
});
test("ambiguous timeout retries with identical key and payload, treating accepted 409 as success", async () => {
  const calls = [];
  const f = await fixture({ fetchLine: async (url, options) => {
    calls.push(options); if (calls.length === 1) throw new Error("connection lost");
    return { ok: false, status: 409, headers: new Map([["x-line-accepted-request-id", "accepted"]]) };
  } });
  await f.webhook([event()]);
  const body = { text: "reply", operationId: randomUUID() };
  assert.equal((await f.request(replyPath(), { method: "POST", body })).body.message.status, "uncertain");
  assert.equal((await f.request(replyPath(), { method: "POST", body })).body.message.status, "sent");
  assert.equal(calls[0].headers["X-Line-Retry-Key"], calls[1].headers["X-Line-Retry-Key"]);
  assert.equal(calls[0].body, calls[1].body);
});
test("same operation cannot change message content or recipient", async () => {
  const f = await fixture(); await f.webhook([event()]);
  const body = { text: "first", operationId: randomUUID() };
  await f.request(replyPath(), { method: "POST", body });
  assert.equal((await f.request(replyPath(), { method: "POST", body: { ...body, text: "different" } })).code, 409);
  const other = event("2"); other.source.userId = `U${"d".repeat(32)}`; await f.webhook([other]);
  assert.equal((await f.request(`/api/line/conversations/${normalizeEvent(other).conversationId}/messages`, { method: "POST", body })).code, 409);
});
test("concurrent requests claim only one send and keep the same durable operation", async () => {
  const f = await fixture(); await f.webhook([event()]);
  const id = randomUUID(), conversationId = normalizeEvent(event()).conversationId;
  const results = await Promise.all(Array.from({ length: 5 }, () => f.store.prepareReply("1234567890", conversationId, id, "hello", 1000000)));
  assert.equal(results.filter(result => result.claimed).length, 1);
  assert.equal(new Set(results.map(result => result.retryKey)).size, 1);
});
test("retries expire before LINE's 24h window and acknowledged success is never downgraded", async () => {
  const f = await fixture(); await f.webhook([event()]);
  const id = randomUUID(), cid = normalizeEvent(event()).conversationId;
  await f.store.prepareReply("1234567890", cid, id, "hello", 1000);
  await assert.rejects(f.store.prepareReply("1234567890", cid, id, "hello", 1000 + 23 * 3600000), { status: 409 });
  await f.store.finishReply("1234567890", id, "sent", "accepted");
  assert.equal((await f.store.finishReply("1234567890", id, "failed", "late response")).status, "sent");
});
test("LINE rejection is recorded as failure, while failed confirmation of an ambiguous attempt remains uncertain", async () => {
  let mode = "reject";
  const f = await fixture({ fetchLine: async () => { if (mode === "timeout") throw new Error("timeout"); return { ok: false, status: 429 }; } });
  await f.webhook([event()]);
  assert.equal((await f.request(replyPath(), { method: "POST", body: { text: "hello", operationId: randomUUID() } })).body.message.status, "failed");
  mode = "timeout";
  const body = { text: "uncertain", operationId: randomUUID() };
  await f.request(replyPath(), { method: "POST", body }); mode = "reject";
  assert.equal((await f.request(replyPath(), { method: "POST", body })).body.message.status, "uncertain");
});
test("wrong channel token is rejected before binding; foreign origin is refused", async () => {
  const f = await fixture({ fetchLine: async () => ({ ok: true, json: async () => ({ client_id: "9876543210" }) }) });
  const body = { channelId: "1234567890", channelSecret: secret, accessToken: "token".repeat(20) };
  assert.equal((await f.request("/api/line/account", { method: "POST", body })).code, 400);
  assert.equal((await f.request("/api/line/account", { method: "POST", body, headers: { origin: "https://evil.example" } })).code, 403);
});
test("message pagination covers all messages without duplicates", async () => {
  const f = await fixture();
  for (let i = 0; i < 55; i++) await f.store.ingest("1234567890", normalizeEvent(event(String(i), i + 1)));
  const id = normalizeEvent(event()).conversationId;
  const first = await f.store.messages("1234567890", id);
  const second = await f.store.messages("1234567890", id, first.next);
  assert.equal(first.items.length, 50); assert.equal(second.items.length, 5);
  assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 55);
});
test("unsupported event data cannot inject document paths; attachments are typed placeholders", () => {
  const malformed = event(); malformed.message.id = "../stolen";
  assert.equal(normalizeEvent(malformed), null);
  const picture = event(); picture.message.type = "image";
  assert.equal(normalizeEvent(picture).text, "[圖片]");
});

test("profile lookup is owner scoped, cached and preserved by incoming messages", async () => {
  let calls = 0;
  const f = await fixture({ fetchLine: async (url, options) => {
    calls++;
    assert.match(url, /\/v2\/bot\/profile\/U[c]{32}$/);
    assert.equal(options.headers.Authorization, "Bearer test-access-token");
    return { ok: true, json: async () => ({ displayName: "小林", pictureUrl: "https://profile.line-scdn.net/example", statusMessage: "private extra field" }) };
  } });
  await f.webhook([event()]);
  assert.equal((await f.request("/api/line/conversations", { token: "bob" })).body.items.length, 0);
  assert.equal(calls, 0);
  const first = await f.request("/api/line/conversations");
  assert.equal(first.body.items[0].displayName, "小林");
  assert.equal(first.body.items[0].pictureUrl, "https://profile.line-scdn.net/example");
  assert.equal(first.body.items[0].statusMessage, undefined);
  await f.webhook([event("2", 2000)]);
  const second = await f.request("/api/line/conversations");
  assert.equal(second.body.items[0].displayName, "小林");
  assert.equal(second.body.items[0].lastText, "message 2");
  assert.equal(calls, 1);
});
test("unavailable profiles do not block inbox and failures are cached", async () => {
  let calls = 0;
  const f = await fixture({ fetchLine: async () => { calls++; throw new Error("unavailable"); } });
  await f.webhook([event()]);
  assert.equal((await f.request("/api/line/conversations")).code, 200);
  assert.equal((await f.request("/api/line/conversations")).body.items[0].lastText, "message 1");
  assert.equal(calls, 1);
});
test("untrusted image hosts are rejected and concurrent lookups share a lease", async () => {
  let calls = 0;
  const f = await fixture({ fetchLine: async () => { calls++; return { ok: true, json: async () => ({ displayName: "Test", pictureUrl: "https://example.com/tracker" }) }; } });
  await f.webhook([event()]);
  await Promise.all([f.request("/api/line/conversations"), f.request("/api/line/conversations")]);
  assert.equal(calls, 1);
  assert.equal((await f.request("/api/line/conversations")).body.items[0].pictureUrl, "");
});

test("image uploads use scoped storage and expiring links; retries preserve image payload", async () => {
  let clock = 1800000000000, calls = 0;
  const objects = new Map(), sent = [];
  const f = await fixture({ now: () => clock, media: { save: async (path, bytes) => objects.set(path, bytes), read: async path => objects.get(path) }, fetchLine: async (url, options) => {
    sent.push(JSON.parse(options.body)); calls++;
    return calls === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 };
  } });
  await f.webhook([event()]);
  const id = (await f.store.conversations("1234567890")).items[0].id;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=';
  const uploaded = await f.request(`/api/line/conversations/${id}/attachments`, { method: 'POST', body: { kind: 'image', name: 'photo.png', data: png } });
  assert.equal(uploaded.code, 200);
  assert.equal(objects.size, 1);
  const attachment = uploaded.body.attachment;
  const publicPath = attachment.url.replace('https://planning-with-ai-52d58.web.app', '');
  const downloaded = await f.request(publicPath, { token: null });
  assert.equal(downloaded.code, 200); assert.equal(downloaded.body.toString('base64'), png);
  assert.equal(downloaded.headers['Content-Type'], 'image/png');
  assert.equal((await f.request(publicPath.replace('signature=', 'signature=0'), { token: null })).code, 403);
  const body = { text: '😊 照片給你', attachmentId: attachment.id, operationId: randomUUID() };
  const first = await f.request(`/api/line/conversations/${id}/messages`, { method: 'POST', body });
  assert.equal(first.body.message.status, 'uncertain');
  clock += 21000;
  const retry = await f.request(`/api/line/conversations/${id}/messages`, { method: 'POST', body });
  assert.equal(retry.body.message.status, 'sent');
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].messages[0].type, 'image');
  assert.equal(sent[0].messages[0].previewImageUrl, attachment.url);
  assert.equal(sent[0].messages[1].text, body.text);
  clock = attachment.expiresAt + 1;
  assert.equal((await f.request(publicPath, { token: null })).code, 403);
});
test("documents send download links and cannot be attached to another conversation or tenant", async () => {
  let payload;
  const f = await fixture({ now: () => 1800000000000, media: { save: async () => {}, read: async () => Buffer.from('file') }, fetchLine: async (url, options) => { payload = JSON.parse(options.body); return { ok: true }; } });
  await f.webhook([event()]);
  const id = (await f.store.conversations('1234567890')).items[0].id;
  const uploaded = await f.request(`/api/line/conversations/${id}/attachments`, { method:'POST', body:{kind:'file',name:'說明.txt',data:Buffer.from('demo').toString('base64')} });
  const attachment = uploaded.body.attachment;
  const body = {text:'',attachmentId:attachment.id,operationId:randomUUID()};
  assert.equal((await f.request(`/api/line/conversations/${id}/messages`,{method:'POST',body,token:'bob'})).code,404);
  await f.webhook([{...event('2',2000),source:{type:'user',userId:`U${'d'.repeat(32)}`}}]);
  const other = (await f.store.conversations('1234567890')).items.find(item=>item.id!==id).id;
  assert.equal((await f.request(`/api/line/conversations/${other}/messages`,{method:'POST',body})).code,400);
  assert.equal((await f.request(`/api/line/conversations/${id}/messages`,{method:'POST',body})).code,200);
  assert.equal(payload.messages[0].type,'text'); assert.ok(payload.messages[0].text.includes(attachment.url));
  const downloaded = await f.request(attachment.url,{token:null});
  assert.match(downloaded.headers['Content-Disposition'],/^attachment;/);
  assert.equal(downloaded.headers['Content-Security-Policy'],"default-src 'none'; sandbox");
  assert.equal((await f.request(`/api/line/conversations/${id}/messages`,{method:'POST',body:{...body,attachmentId:randomUUID()}})).code,409);
});
test("upload validation rejects active files, forged images, oversized data and anonymous access", async () => {
  for (const value of [
    {kind:'file',name:'page.html',data:'YWJj'}, {kind:'image',name:'fake.png',data:'YWJj'},
    {kind:'file',name:'../file.pdf',data:'YWJj'}, {kind:'file',name:'empty.txt',data:''},
    {kind:'file',name:'big.pdf',data:Buffer.alloc(5*1024*1024+1).toString('base64')},
  ]) assert.throws(()=>validateUpload(value));
  const f = await fixture();
  const result = await f.request(`/api/line/conversations/${'a'.repeat(64)}/attachments`,{token:null,method:'POST',body:{}});
  assert.equal(result.code,401);
  await f.webhook([event()]);
  const id = (await f.store.conversations('1234567890')).items[0].id;
  for (let i=0;i<20;i++) await f.store.reserveUpload('1234567890',id,5*1024*1024,1000000);
  await assert.rejects(f.store.reserveUpload('1234567890',id,1,1000000),error=>error.status===429);
});
