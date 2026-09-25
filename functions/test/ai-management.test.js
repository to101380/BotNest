import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { createHandler, normalizeEvent, seal } from "../core.js";
import { createStore } from "../store.js";
import { memoryDb } from "./memory.js";
import { normalizeAiSettings, validateAiSettings, aiEligibility, withinBusinessHours, retrieveKnowledge } from "../ai-policy.js";
import { importFile, publicAddress, validatePublicUrl } from "../knowledge.js";
import { generateAnswer } from "../ai-engine.js";
import { createAiResponder, createZernioAiResponder } from "../ai.js";

const key = randomBytes(32).toString("base64"), channelId = "1234567890", now = 1000000;
const origin = "https://planning-with-ai-52d58.web.app";
const answer = (extra = {}) => ({ action: "reply", text: "您好，有什麼可以協助您？", grounded: true, kind: "greeting", reason: "一般招呼", sourceIds: [], ...extra });
const response = value => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] }), { headers: { "Content-Type": "application/json" } });
async function fixture(overrides = {}) {
  const db = memoryDb(), store = createStore(db);
  await store.bind("alice", { channelId, ownerUid: "alice", accessToken: seal("demo-token", key, `${channelId}:access-token`) });
  const handler = createHandler({ store, authorizeSession: async () => {}, getKey: () => key, now: () => now, getOpenAiKey: () => "test-key", verifyToken: async token => ({ uid: token, firebase: { sign_in_provider: "google.com" } }),
    fetchLine: async () => { throw new Error("No live LINE calls"); }, fetchOpenAi: async () => response(answer()), ...overrides });
  const request = async (url, { method = "GET", body, token = "alice" } = {}) => {
    const headers = { origin, authorization: `Bearer ${token}` }, res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ originalUrl: `/api/ai/${url}`, method, body, get: name => headers[name.toLowerCase()] }, res); return res;
  };
  const message = async (text = "你好", id = "incoming") => {
    const event = normalizeEvent({ type: "message", webhookEventId: `event-${id}`, timestamp: now - 100, source: { type: "user", userId: `U${"b".repeat(32)}` }, message: { id, type: "text", text } });
    await store.ingest(channelId, event); return { channelId, conversationId: event.conversationId, messageId: event.messageId };
  };
  return { db, store, request, message };
}

test("AI settings migrate old prompts, preserve extended rules and isolate tenants without requiring a channel", async () => {
  const f = await fixture(); await f.store.saveAiSettings(channelId, { enabled: true, instructions: "原有商家指示" }, 1);
  assert.equal((await f.request("settings")).body.settings.instructions, "原有商家指示");
  const saved = await f.request("settings", { method: "PUT", body: { role: "花店客服", channels: { line: false, facebook: true }, humanPauseMinutes: 45 } });
  assert.equal(saved.code, 200); assert.equal(saved.body.settings.instructions, "原有商家指示");
  const partial = validateAiSettings({ enabled: false, instructions: "新的簡易指示" }, await f.store.accountAiSettings("alice"));
  assert.equal(partial.humanPauseMinutes, 45); assert.equal(partial.channels.line, false);
  const bob = await f.request("settings", { token: "bob", method: "PUT", body: { businessInfo: "另一家商店" } });
  assert.equal(bob.code, 200); assert.equal((await f.request("settings")).body.settings.businessInfo, "");
  await f.store.bind("bob", { channelId: "9876543210", ownerUid: "bob" });
  assert.equal((await f.store.accountAiSettings("bob")).businessInfo, "另一家商店");
  assert.equal((await f.request("settings", { method: "PUT", body: { model: "unapproved" } })).code, 400);
});

test("schedule handles Taiwan overnight hours, boundaries, pause, channels and human handoff", () => {
  const schedule = { mode: "inside", timezone: "Asia/Taipei", days: [1], start: "22:00", end: "02:00" };
  assert.equal(withinBusinessHours(schedule, Date.parse("2026-09-14T23:00:00+08:00")), true);
  assert.equal(withinBusinessHours(schedule, Date.parse("2026-09-15T01:00:00+08:00")), true);
  assert.equal(withinBusinessHours(schedule, Date.parse("2026-09-15T02:00:00+08:00")), false);
  assert.equal(withinBusinessHours(schedule, Date.parse("2026-09-15T23:00:00+08:00")), false);
  const ai = normalizeAiSettings({ enabled: true, channels: { facebook: false } });
  assert.equal(aiEligibility(ai, "facebook", {}, now).allowed, false);
  for (const control of [{ mode: "human" }, { mode: "off" }, { pausedUntil: now + 1 }]) assert.equal(aiEligibility(ai, "line", control, now).allowed, false);
  assert.equal(aiEligibility(ai, "line", { pausedUntil: now }, now).allowed, true);
  assert.equal(aiEligibility({ enabled: false }, "line", {}, now, { preview: true }).allowed, true);
  assert.throws(() => validateAiSettings({ humanPauseMinutes: 0 }));
  assert.throws(() => validateAiSettings({ schedule: { ...schedule, timezone: "fake" } }));
});

test("knowledge CRUD and logs are tenant scoped and deletion removes content without limiting future records", async () => {
  const f = await fixture(), input = { title: "營業時間", content: "每天上午九點至下午六點營業", enabled: true };
  const created = await f.request("knowledge", { method: "POST", body: input }); assert.equal(created.code, 200);
  const id = created.body.item.id;
  assert.deepEqual((await f.request("knowledge", { token: "bob" })).body.items, []);
  assert.equal((await f.request(`knowledge/${id}`, { method: "DELETE", token: "bob" })).code, 404);
  assert.equal((await f.request(`knowledge/${id}`, { method: "PUT", body: { ...input, content: "已修改的營業時間", enabled: false } })).body.item.enabled, false);
  await f.request(`knowledge/${id}`, { method: "DELETE" }); assert.deepEqual((await f.request("knowledge")).body.items, []);
  assert.ok(!JSON.stringify([...f.db.data]).includes("已修改的營業時間"));
  for (let i = 0; i < 105; i++) { const temporary = randomUUID(); await f.store.saveAiKnowledge("alice", temporary, input, i + 1); await f.store.deleteAiKnowledge("alice", temporary, i + 1); }
  await f.store.saveAiKnowledge("alice", randomUUID(), input, now);
  assert.equal((await f.store.aiKnowledge("alice")).length, 1);
  await f.store.saveAiLog("alice", randomUUID(), { createdAt: now, question: "商家私有問題" });
  assert.deepEqual((await f.request("logs", { token: "bob" })).body.items, []);
});

test("knowledge quota remains correct across edits and deletions", async () => {
  const { store } = await fixture();
  const ids = Array.from({ length: 40 }, () => randomUUID()), item = { title: "FAQ", content: "test content", enabled: true };
  for (const id of ids) await store.saveAiKnowledge("alice", id, item, now);
  await assert.rejects(store.saveAiKnowledge("alice", randomUUID(), item, now), { status: 429 });
  await store.saveAiKnowledge("alice", ids[0], { ...item, content: "edited content" }, now);
  await store.deleteAiKnowledge("alice", ids[0], now);
  await store.saveAiKnowledge("alice", randomUUID(), item, now);
  assert.equal((await store.aiKnowledge("alice")).length, 40);
});

test("website imports reject loopback, private addresses, mapped IPv6, credentials and mixed DNS results", async () => {
  for (const value of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"]) assert.equal(publicAddress(value), false, value);
  assert.equal(publicAddress("8.8.8.8"), true);
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com:8443", "https://127.0.0.1", "https://[::1]", "https://[::ffff:127.0.0.1]"]) await assert.rejects(validatePublicUrl(url));
  await assert.rejects(validatePublicUrl("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]));
  assert.equal((await validatePublicUrl("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }])).address.address, "8.8.8.8");
});

test("PDF, DOCX and text import extract real text into disabled drafts", async () => {
  const text = await importFile({ name: "faq.txt", data: Buffer.from("商家資料：週一至五上午九點營業").toString("base64") });
  assert.equal(text.enabled, false); assert.match(text.content, /上午九點/);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>商品配送時間為三個工作天</w:t></w:r></w:p></w:body></w:document>');
  const docx = await importFile({ name: "policy.docx", data: await zip.generateAsync({ type: "base64" }) });
  assert.match(docx.content, /三個工作天/); assert.equal(docx.enabled, false);
  const stream = "BT /F1 12 Tf 50 700 Td (Business hours: 9am to 6pm) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const imported = await importFile({ name: "hours.pdf", data: Buffer.from(pdf).toString("base64") });
  assert.match(imported.content, /9am to 6pm/); assert.equal(imported.enabled, false);
  await assert.rejects(importFile({ name: "old.doc", data: Buffer.from("legacy word").toString("base64") }), { status: 400 });
  await assert.rejects(importFile({ name: "empty.txt", data: Buffer.from("  ").toString("base64") }), { status: 422 });
});

test("answers cite only enabled matching knowledge; unknown citations and ungrounded claims hand off", async () => {
  const knowledge = [{ id: "hours", title: "營業時間", content: "週一至五上午九點至下午六點營業", enabled: true }, { id: "draft", title: "營業時間", content: "錯誤草稿", enabled: false }];
  assert.deepEqual(retrieveKnowledge(knowledge, "請問營業時間？", {}).map(item => item.id), ["hours:1"]);
  const input = { settings: {}, knowledge, history: [{ role: "user", content: "請問營業時間？" }], getOpenAiKey: () => "test-key" };
  const result = await generateAnswer({ ...input, fetchOpenAi: async () => response(answer({ kind: "answer", sourceIds: ["hours:1"] })) });
  assert.equal(result.action, "reply"); assert.equal(result.sources[0].documentId, "hours");
  for (const extra of [{ sourceIds: ["invented"] }, { sourceIds: [] }, { grounded: false, sourceIds: ["hours:1"] }]) {
    const result = await generateAnswer({ ...input, fetchOpenAi: async () => response(answer({ kind: "answer", ...extra })) });
    assert.equal(result.action, "handoff");
  }
  const handoff = await generateAnswer({ ...input, history: [{ role: "user", content: "我要退款" }], fetchOpenAi: () => { throw new Error("Keyword handoff needs no model call"); } });
  assert.equal(handoff.action, "handoff");
  await assert.rejects(generateAnswer({ ...input, fetchOpenAi: async () => new Response('{"output":[]}') }), { status: 502 });
});

test("casual conversation replies without knowledge while unsupported business facts still hand off", async () => {
  const input = { settings: {}, knowledge: [], history: [{ role: "user", content: "你覺得今天心情如何？" }], getOpenAiKey: () => "test-key" };
  const casual = await generateAnswer({ ...input, fetchOpenAi: async () => response(answer({ kind: "casual", sourceIds: [], grounded: true, reason: "一般閒聊，不涉及商家事實" })) });
  assert.equal(casual.action, "reply");
  const unsupported = await generateAnswer({ ...input, history: [{ role: "user", content: "這件商品多少錢？" }], fetchOpenAi: async () => response(answer({ kind: "answer", sourceIds: [], grounded: true, reason: "沒有價格資料" })) });
  assert.equal(unsupported.action, "handoff");
});

test("test area uses saved policy and sources without sending messages or changing real conversations", async () => {
  const f = await fixture({ fetchOpenAi: async () => response(answer({ kind: "answer", sourceIds: ["business:1"], text: "每天九點營業" })) });
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: false, businessInfo: "每天九點營業" }), now);
  const result = await f.request("test", { method: "POST", body: { question: "請問營業時間？", provider: "facebook" } });
  assert.equal(result.code, 200); assert.equal(result.body.liveEnabled, false); assert.equal(result.body.result.sources[0].documentId, "business");
  assert.equal((await f.request("logs")).body.items[0].test, true);
  assert.ok(![...f.db.data.keys()].some(path => path.includes("aiConversations") || path.includes("outbox")));
  const refund = await f.request("test", { method: "POST", body: { question: "我要退款" } }); assert.equal(refund.body.result.action, "handoff");
  assert.equal((await f.request("test", { method: "POST", body: { question: "hi", history: [{ role: "system", content: "hack" }] } })).code, 400);
});

test("conversation control verifies ownership and rejects stale control revisions", async () => {
  const f = await fixture(), message = await f.message();
  const body = { provider: "line", conversationId: message.conversationId, mode: "human", revision: 0 };
  assert.equal((await f.request("conversation", { method: "PUT", token: "bob", body })).code, 404);
  const result = await f.request("conversation", { method: "PUT", body }); assert.equal(result.body.control.revision, 1); assert.equal(result.body.state.allowed, false);
  assert.equal((await f.request("conversation", { method: "PUT", body: { ...body, mode: "auto" } })).code, 409);
  assert.equal((await f.request("conversation", { method: "PUT", body: { ...body, mode: "auto", revision: 1 } })).body.control.mode, "auto");
});

test("human takeover during inference cancels a pending LINE reply and records the reason", async () => {
  const f = await fixture(), message = await f.message(); let sends = 0;
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true }), now);
  const responder = createAiResponder({ store: f.store, getKey: () => key, getOpenAiKey: () => "test-key", now: () => now,
    fetchOpenAi: async () => { await f.store.setAiControl("alice", "line", message.conversationId, { mode: "human", reason: "真人客服處理中" }, now); return response(answer()); },
    fetchLine: async url => { if (!url.endsWith("/loading/start")) sends++; return new Response("{}"); } });
  assert.deepEqual(await responder(message), { skipped: true }); assert.equal(sends, 0);
  assert.equal((await f.store.aiLogs("alice")).items[0].reason, "真人客服處理中");
});

test("refund handoff persists human mode, acknowledgement is sent once, and later messages stay with the human", async () => {
  const f = await fixture(), message = await f.message("我要退款"); let sends = 0;
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true }), now);
  f.store.aiKnowledge = async () => { throw new Error("Keyword handoff must not read the knowledge collection"); };
  const responder = createAiResponder({ store: f.store, getKey: () => key, getOpenAiKey: () => "test-key", now: () => now,
    fetchOpenAi: async () => { throw new Error("Must not call model"); }, fetchLine: async url => { if (!url.endsWith("/loading/start")) sends++; return new Response("{}"); } });
  assert.deepEqual(await responder(message), { handoff: true }); assert.equal((await f.store.aiControl("alice", "line", message.conversationId)).mode, "human");
  assert.deepEqual(await responder(message), { skipped: true });
  assert.deepEqual(await responder(await f.message("謝謝", "second")), { skipped: true }); assert.equal(sends, 1);
});

test("manual reply pauses AI for the configured duration and preserves explicit human mode", async () => {
  const f = await fixture(), message = await f.message();
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true, humanPauseMinutes: 45 }), now);
  await f.store.pauseAiForHuman("alice", "line", message.conversationId, now);
  let control = await f.store.aiControl("alice", "line", message.conversationId); assert.equal(control.pausedUntil, now + 45 * 60000);
  assert.equal(aiEligibility(await f.store.accountAiSettings("alice"), "line", control, now).allowed, false);
  assert.equal(aiEligibility(await f.store.accountAiSettings("alice"), "line", control, control.pausedUntil).allowed, true);
  await f.store.setAiControl("alice", "line", message.conversationId, { mode: "human" }, now);
  await f.store.pauseAiForHuman("alice", "line", message.conversationId, now + 100);
  control = await f.store.aiControl("alice", "line", message.conversationId); assert.equal(control.mode, "human");
});

test("failed model calls leave failure logs and never send malformed answers or retry completed failures", async () => {
  const f = await fixture(), message = await f.message(); let calls = 0;
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true }), now);
  const responder = createAiResponder({ store: f.store, getKey: () => key, getOpenAiKey: () => "test-key", now: () => now,
    fetchOpenAi: async () => { calls++; return new Response('{"error":"bad"}', { status: 502 }); }, fetchLine: async () => { throw new Error("Must not send"); } });
  await assert.rejects(responder(message)); assert.equal((await f.store.aiLogs("alice")).items[0].status, "failed");
  assert.deepEqual(await responder(message), { skipped: true }); assert.equal(calls, 1);
});

test("Messenger respects channel selection and uses persistent control for handoff", async () => {
  const f = await fixture(), accountId = "a".repeat(24), profileId = "b".repeat(24);
  await f.store.saveZernioProfile("alice", profileId, now); await f.store.bindZernioFacebook("alice", profileId, { accountId, platform: "facebook" }, now);
  const ingest = text => f.store.ingestZernio("alice", { eventId: randomUUID(), accountId, remoteConversationId: "thread", remoteMessageId: randomUUID(), text, sentAt: now, displayName: "Demo", pictureUrl: "" });
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true, channels: { facebook: false } }), now);
  let sends = 0;
  const responder = createZernioAiResponder({ store: f.store, getOpenAiKey: () => "test-key", getZernioKey: () => "test-key", now: () => now,
    fetchOpenAi: async () => { throw new Error("No model needed"); }, fetchZernio: async (_url, options) => { if (options.method === "POST" && !_url.endsWith("/typing")) sends++; return new Response(JSON.stringify({ messages: [] })); } });
  let item = await ingest("你好"); assert.deepEqual(await responder({ uid: "alice", ...item }), { skipped: true }); assert.equal(sends, 0);
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true }), now);
  item = await ingest("我有客訴"); assert.deepEqual(await responder({ uid: "alice", ...item }), { handoff: true }); assert.equal(sends, 1);
  assert.equal((await f.store.aiControl("alice", "facebook", item.conversationId)).mode, "human");
});

for (const provider of ["line", "facebook", "instagram"]) test(`${provider} shows typing before inference, tolerates failure and skips it when AI is off`, async () => {
  const f = await fixture(), calls = [], accountId = "a".repeat(24), profileId = "b".repeat(24);
  let item;
  if (provider === "line") item = await f.message();
  else {
    await f.store.saveZernioProfile("alice", profileId, now);
    await f.store.bindZernioPlatform("alice", profileId, provider, { accountId, platform: provider }, now);
    item = { uid: "alice", ...await f.store.ingestZernio("alice", { provider, eventId: randomUUID(), accountId, remoteConversationId: "thread", remoteMessageId: randomUUID(), text: "你好", sentAt: now, displayName: "Demo", pictureUrl: "" }) };
  }
  const transport = async (url, options = {}) => {
    if (url.endsWith("/typing") || url.endsWith("/loading/start")) {
      calls.push("typing");
      const body = JSON.parse(options.body);
      assert.deepEqual(body, provider === "line" ? { chatId: `U${"b".repeat(32)}`, loadingSeconds: 30 } : { accountId });
      assert.ok(options.signal);
      throw new Error("Typing unavailable");
    }
    if (options.method === "POST") calls.push("send");
    return response({ messages: [] });
  };
  const options = { store: f.store, getKey: () => key, getOpenAiKey: () => "test", getZernioKey: () => "test", now: () => now,
    fetchLine: transport, fetchZernio: transport, fetchOpenAi: async () => { calls.push("model"); return response(answer()); } };
  const responder = provider === "line" ? createAiResponder(options) : createZernioAiResponder(options);
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true }), now);
  assert.deepEqual(await responder(item), { sent: true });
  assert.deepEqual(calls, ["typing", "model", "send"]);
  assert.deepEqual(await responder(item), { skipped: true });
  assert.equal(calls.length, 3);
  await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: false }), now);
  const next = provider === "line" ? await f.message("你好", "disabled") : { uid: "alice", ...await f.store.ingestZernio("alice", { provider, eventId: randomUUID(), accountId, remoteConversationId: "thread", remoteMessageId: randomUUID(), text: "你好", sentAt: now, displayName: "Demo", pictureUrl: "" }) };
  assert.deepEqual(await responder(next), { skipped: true });
  assert.equal(calls.length, 3);
});

for (const mode of ["complete", "human", "new-message", "off", "failure", "disabled"]) test(`social split replies: ${mode}`, async () => {
 const f = await fixture(), accountId = "a".repeat(24), profileId = "b".repeat(24), sends = [], waits = [];
 await f.store.saveZernioProfile("alice", profileId, now);
 await f.store.bindZernioPlatform("alice", profileId, "instagram", { accountId, platform: "instagram" }, now);
 await f.store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true, splitReplies: { instagram: mode !== "disabled" } }), now);
 const ingest = () => f.store.ingestZernio("alice", { provider: "instagram", eventId: randomUUID(), accountId, remoteConversationId: "thread", remoteMessageId: randomUUID(), text: "你好", sentAt: now, displayName: "Demo", pictureUrl: "" });
 const item = { uid: "alice", ...await ingest() };
 const long = "您好，歡迎您來到我們的線上客服，我很樂意陪您一起了解各項資訊並解答您的問題。\n\n您可以先告訴我希望了解的服務內容，以及您目前的需求，我會依照您的情況協助整理。\n\n如果您有其他需要也可以隨時告訴我，我會盡力提供清楚且容易理解的說明，讓您放心選擇。";
 const responder = createZernioAiResponder({ store: f.store, getOpenAiKey: () => "test", getZernioKey: () => "test", now: () => now,
  fetchOpenAi: async () => response(answer({text: long})),
  wait: async ms => { waits.push(ms); if (mode === "human") await f.store.setAiControl("alice", "instagram", item.conversationId, {mode:"human"}, now); if (mode === "new-message") await ingest(); if (mode === "off") await f.store.saveAccountAiSettings("alice", normalizeAiSettings({enabled:false}), now); },
  fetchZernio: async (url, options = {}) => { if (options.method === "POST" && url.endsWith("/messages")) { if (mode === "failure" && sends.length === 1) throw Error("ambiguous timeout"); sends.push({text:JSON.parse(options.body).message, key:options.headers["Idempotency-Key"]}); } return response({messages:[]}); }
 });
 if (mode === "failure") await assert.rejects(responder(item)); else await responder(item);
 assert.equal(sends.length, mode === "complete" ? 3 : 1);
 if (mode === "complete") { assert.equal(new Set(sends.map(x=>x.key)).size,3); assert.equal(sends.map(x=>x.text).join("\n\n"),long); }
 assert.ok(waits.every(ms=>ms>=1000 && ms<=2000));
 const log=(await f.store.aiLogs("alice")).items[0]; assert.equal(log.sentParts,sends.length);
 await responder(item); assert.equal(sends.length,mode === "complete" ? 3 : 1);
});

const ocrResponse = value => new Response(JSON.stringify(value));
test("image OCR imports a disabled draft through authenticated tenant API", async () => {
 const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=";
 let calls = 0;
 const f = await fixture({getOpenAiKey:()=>"test", fetchOpenAi:async (_url, options)=>{
  calls++; const body=JSON.parse(options.body); assert.equal(body.store,false);
  assert.equal(body.input[0].content[1].image_url,`data:image/png;base64,${data}`);
  return ocrResponse({status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify({content:"珍珠奶茶 60 元\n營業時間 09:00–18:00"})}]}]});
 }});
 const result=await f.request("knowledge/import",{method:"POST",body:{kind:"file",name:"menu.png",data}});
 assert.equal(result.code,200); assert.equal(result.body.item.enabled,false); assert.match(result.body.item.content,/60 元/);
 assert.ok(!JSON.stringify(result.body).includes(data));
 assert.equal((await f.request("knowledge",{token:"bob"})).body.items.length,0);
 assert.equal(calls,1);
});

test("OCR rejects disguised files, missing keys, empty and truncated results", async () => {
 const data="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=";
 await assert.rejects(importFile({name:"fake.png",data:Buffer.from("not an image").toString("base64")}), /圖片格式/);
 await assert.rejects(importFile({name:"menu.png",data}), /OpenAI API Key/);
 for (const [status,content] of [["incomplete","部分文字"],["completed",""]]) {
  await assert.rejects(importFile({name:"menu.png",data},{getOpenAiKey:()=>"test",fetchOpenAi:async()=>ocrResponse({status,output:[{content:[{type:"output_text",text:JSON.stringify({content})}]}]})}), error=>error.status===422);
 }
});

test("generic product questions include small enabled catalogs without lexical overlap", () => {
 const sources = retrieveKnowledge([{id:"menu",title:"image.jpg",content:"芒果乾 200 元；蘋果脆片 150 元",enabled:true},{id:"draft",title:"草稿",content:"秘密品項",enabled:false}], "你們有什麼商品？", normalizeAiSettings());
 assert.equal(sources.length,1); assert.equal(sources[0].documentId,"menu"); assert.match(sources[0].excerpt,/200 元/);
});
test("needs clarification can reply without citations while unsupported prices still hand off", async () => {
 const args={settings:normalizeAiSettings({enabled:true}),knowledge:[],history:[{role:"user",content:"我再考慮看看"}],getOpenAiKey:()=>"test"};
 const clarified=await generateAnswer({...args,fetchOpenAi:async()=>response(answer({kind:"clarification",text:"您比較偏好哪種類型呢？"}))});
 assert.equal(clarified.action,"reply");
 const unsupported=await generateAnswer({...args,fetchOpenAi:async()=>response(answer({kind:"answer",text:"售價 100 元。"}))});
 assert.equal(unsupported.action,"handoff"); assert.match(unsupported.reason,/缺少有效/);
});

test("LINE long answers send multiple bubbles in exactly one push and do not resend", async () => {
 const f=await fixture(), item=await f.message(), pushes=[];
 const long="您好，歡迎您來到我們的線上客服，我很樂意陪您一起了解各項資訊並解答您的問題。\n\n您可以先告訴我希望了解的服務內容，以及您目前的需求，我會依照您的情況協助整理。\n\n如果您有其他需要也可以隨時告訴我，我會盡力提供清楚且容易理解的說明，讓您放心選擇。";
 await f.store.saveAccountAiSettings("alice",normalizeAiSettings({enabled:true}),now);
 const responder=createAiResponder({store:f.store,getKey:()=>key,getOpenAiKey:()=>"test",now:()=>now,
 fetchOpenAi:async()=>response(answer({text:long})),fetchLine:async(url,options)=>{if(url.endsWith("/push"))pushes.push(JSON.parse(options.body));return new Response("{}");}});
 assert.deepEqual(await responder(item),{sent:true}); assert.equal(pushes.length,1);
 assert.equal(pushes[0].messages.length,3); assert.equal(pushes[0].messages.map(x=>x.text).join("\n\n"),long);
 await responder(item); assert.equal(pushes.length,1);
});
