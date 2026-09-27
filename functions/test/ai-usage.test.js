import test from "node:test";
import assert from "node:assert/strict";
import { createUsageStore, meteredOpenAi, tokenCost, usageMonth, handleUsage } from "../ai-usage.js";
import { memoryDb } from "./memory.js";
import { MONITOR_GOOGLE_ID } from "../security-monitor.js";
import { createHandler } from "../core.js";
import { createStore } from "../store.js";
import { handleAiApi } from "../ai-api.js";
const now = () => Date.parse("2026-09-27T13:00:00Z");
const url = "https://api.openai.com/v1/responses";
const options = { body: JSON.stringify({ model: "gpt-5.4-mini", instructions: "private business text", input: [{ role: "user", content: [{ type: "input_image", image_url: "private-image-url" }] }] }) };
const usage = { input_tokens: 2000, output_tokens: 300, input_tokens_details: { cached_tokens: 1000 } };
const owner = { uid: "owner", firebase: { sign_in_provider: "google.com", identities: { "google.com": [MONITOR_GOOGLE_ID] } } };
async function query(store, user, qs = "") {
  let result; await handleUsage({ store, user, req: { method: "GET" }, res: { json: value => { result = value; } }, query: new URLSearchParams(qs), now }); return result;
}
test("token prices subtract cached input, retain zero, and refuse missing or invalid usage", () => {
  assert.equal(tokenCost("gpt-5.4-mini", usage).nanoUsd, 2175000);
  assert.equal(tokenCost("gpt-5.4-mini-2026-03-17", usage).nanoUsd, 2175000);
  assert.equal(tokenCost("gpt-5.4-mini", { input_tokens: 0, output_tokens: 0 }).nanoUsd, 0);
  assert.equal(tokenCost("gpt-5.4-mini", { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } }).nanoUsd, null);
  assert.equal(tokenCost("unknown", usage).nanoUsd, null);
  assert.equal(tokenCost("gpt-5.4-mini", null).nanoUsd, null);
  assert.equal(usageMonth(Date.parse("2026-09-30T16:00:00Z")), "2026-10");
});
test("provider calls persist metadata before output consumption, without storing content", async () => {
  const db = memoryDb(), store = createUsageStore(db);
  const fetch = meteredOpenAi(store, "alice", { provider: "line" }, async () => Response.json({ usage, output: "unparseable answer" }), now);
  const response = await fetch(url, options); assert.equal((await response.json()).output, "unparseable answer");
  const summary = await store.usageSummary("alice", "2026-09"), value = summary.buckets.line_image;
  assert.equal(value.requests, 1); assert.equal(value.images, 1); assert.equal(value.pending, 0); assert.equal(value.nanoUsd, 2175000);
  assert.equal(value.unknownCost, 0);
  const serialized = JSON.stringify([...db.data.values()]); assert.ok(!serialized.includes("private"));
  assert.equal((await store.usageSummary("bob", "2026-09")).firstAt, null);
});
test("settlement retries and late duplicates cannot double count or roll back a final entry", async () => {
  const store = createUsageStore(memoryDb()); let calls = 0, saves = 0;
  const wrapped = { ...store, saveUsage: async (...args) => { await store.saveUsage(...args); if (++saves === 2) throw Error("lost ack"); } };
  await meteredOpenAi(wrapped, "alice", { provider: "facebook" }, async () => { calls++; return Response.json({ usage }); }, now)(url, options);
  const [entry] = await store.usageEvents("alice", "2026-09");
  await store.saveUsage("alice", { ...entry, status: "pending", cost: tokenCost("", null) });
  const total = (await store.usageSummary(null, "2026-09")).buckets.facebook_image;
  assert.equal(calls, 1); assert.equal(saves, 3); assert.equal(total.requests, 1); assert.equal(total.pending, 0); assert.equal(total.nanoUsd, 2175000);
});
test("failed and uncertain API calls are visible and never silently marked free", async () => {
  const store = createUsageStore(memoryDb());
  await meteredOpenAi(store, "alice", { provider: "line" }, async () => Response.json({ error: "failure" }, { status: 500 }), now)(url, options);
  await assert.rejects(meteredOpenAi(store, "alice", { provider: "line" }, async () => { throw Error("timeout"); }, now)(url, options));
  const total = (await store.usageSummary("alice", "2026-09")).buckets.line_image;
  assert.equal(total.requests, 2); assert.equal(total.failed, 1); assert.equal(total.pending, 1); assert.equal(total.unknownCost, 2);
});
test("metering failure before inference prevents an untracked billable request", async () => {
  let called = false;
  await assert.rejects(meteredOpenAi({ saveUsage: async () => { throw Error("db"); } }, "alice", { provider: "line" }, async () => { called = true; }, now)(url, options));
  assert.equal(called, false);
});
test("merchant responses cannot expose tokens, costs, model, or another tenant via query parameters", async () => {
  const store = createUsageStore(memoryDb());
  await meteredOpenAi(store, "alice", { provider: "instagram" }, async () => Response.json({ usage }), now)(url, options);
  const alice = await query(store, { uid: "alice" });
  assert.equal(alice.buckets.instagram_image.completed, 1);
  for (const key of ["nanoUsd", "inputTokens", "cost", "priceVersion", "model", "unknownCost"]) assert.equal(JSON.stringify(alice).includes(`"${key}"`), false);
  assert.equal((await query(store, { uid: "bob" })).events.length, 0);
  await assert.rejects(query(store, { uid: "bob" }, "uid=alice"), { status: 403 });
  await assert.rejects(query(store, { uid: "bob", admin: true }, "scope=all"), { status: 403 });
  await assert.rejects(query(store, { ...owner, firebase: { ...owner.firebase, sign_in_provider: "password" } }, "scope=all"), { status: 403 });
  const admin = await query(store, owner, "scope=all"); assert.equal(admin.buckets.instagram_image.nanoUsd, 2175000); assert.equal(admin.events.length, 0);
  await assert.rejects(query(store, owner, "month=2026-13"), { status: 400 });
});
test("usage HTTP route requires verified authentication and keeps responses private", async () => {
  const handler = createHandler({ store: createStore(memoryDb()), verifyToken: async token => ({ uid: token, firebase: { sign_in_provider: "google.com" } }), authorizeSession: async () => {}, getKey: () => "", now });
  async function request(token) { const headers = {}, res = { code: 200, set(key, value) { headers[key] = value; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; await handler({ originalUrl: "/api/ai/usage", method: "GET", get: name => name === "authorization" && token ? `Bearer ${token}` : undefined }, res); return { res, headers }; }
  assert.equal((await request()).res.code, 401);
  const result = await request("alice"); assert.equal(result.res.code, 200); assert.match(result.headers["Cache-Control"], /no-store/);
});
test("audio duration comes from the file and its transcription is a separate request", async () => {
  const store = createUsageStore(memoryDb()), wav = Buffer.alloc(44 + 16000 * 2 * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  const body = new FormData(); body.append("model", "gpt-4o-mini-transcribe"); body.append("file", new Blob([wav], { type: "audio/wav" }), "voice.wav");
  const fetch = meteredOpenAi(store, "alice", { provider: "line" }, async () => Response.json({ usage: { input_tokens: 20, output_tokens: 5 }, text: "secret transcription" }), now);
  await fetch("https://api.openai.com/v1/audio/transcriptions", { body }); await fetch(url, options);
  const summary = await store.usageSummary("alice", "2026-09"); assert.equal(summary.buckets.line_audio.audioMs, 2000); assert.equal(summary.buckets.line_audio.unknownDuration, 0); assert.equal(summary.buckets.line_audio.completed, 1); assert.equal(summary.buckets.line_image.completed, 1);
});
test("existing AI log and test APIs do not expose raw usage to merchants", async () => {
  const store = createStore(memoryDb());
  const invoke = async (user, path, req = {}) => { let result; await handleAiApi({ user, path, req: { method: "GET", originalUrl: path, get: () => undefined, ...req }, res: { json: value => { result = value; } }, store, now, getOpenAiKey: () => "test", fetchOpenAi: async () => Response.json({ usage, output: [{ content: [{ type: "output_text", text: JSON.stringify({ action: "reply", text: "你好", reason: "招呼", grounded: true, kind: "greeting", sourceIds: [] }) }] }] }) }); return result; };
  await store.saveAiLog("alice", "row", { createdAt: now(), result: { text: "hello", usage } });
  const logs = await invoke({ uid: "alice" }, "/api/ai/logs"); assert.equal(Object.hasOwn(logs.items[0].result, "usage"), false);
  const result = await invoke({ uid: "alice" }, "/api/ai/test", { method: "POST", body: { question: "你好" } }); assert.equal(Object.hasOwn(result.result, "usage"), false);
  await store.saveAiLog("owner", "row", { createdAt: now(), result: { text: "hello", usage } });
  const admin = await invoke(owner, "/api/ai/logs"); assert.deepEqual(admin.items[0].result.usage, usage);
});
