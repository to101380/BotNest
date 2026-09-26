import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAiSettings, retrieveKnowledge } from "../ai-policy.js";
import { generateAnswer } from "../ai-engine.js";
import { randomBytes, randomUUID } from "node:crypto";
import { createStore } from "../store.js";
import { memoryDb } from "./memory.js";
import { normalizeEvent, seal } from "../core.js";
import { createAiResponder, createZernioAiResponder } from "../ai.js";

test("current business information cannot be crowded out by eight matching old documents", () => {
  const settings = normalizeAiSettings({ businessInfo: "目前費用已調整為每月 990 元。" });
  const knowledge = Array.from({ length: 8 }, (_, i) => ({ id: `old-${i}`, title: "方案價格", content: "舊版入門方案價格 499 元", enabled: true }));
  const sources = retrieveKnowledge(knowledge, "入門方案價格？舊版入門方案價格 499 元", settings);
  assert.ok(sources.some(source => source.documentId === "business" && source.excerpt.includes("990")));
  assert.ok(sources.length <= 8);
});

test("the entire bounded current business information remains available including its final correction", () => {
  const businessInfo = "商家介紹。".repeat(1000) + "最新收費：990 元。";
  const settings = normalizeAiSettings({ businessInfo, instructions: "請簡潔回答。" });
  const sources = retrieveKnowledge([], "介紹", settings);
  const business = sources.filter(source => source.documentId === "business");
  assert.ok(business.some(source => source.excerpt.includes("最新收費：990 元。")));
  assert.ok(business.some(source => source.excerpt.includes("請簡潔回答。")));
});

test("old assistant answers cannot rank obsolete knowledge above the current customer question", async () => {
  let request;
  const knowledge = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `old-${i}`, title: "Archived", content: "alpha bravo charlie delta echo foxtrot", enabled: true })),
    { id: "current", title: "現行配送", content: "配送時間為兩天。", enabled: true },
  ];
  await generateAnswer({ settings: {}, knowledge, history: [
    { role: "assistant", content: "alpha bravo charlie delta echo foxtrot" },
    { role: "user", content: "配送時間？" },
  ], getOpenAiKey: () => "test-only", fetchOpenAi: async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ action: "reply", text: "配送時間為兩天。", reason: "依現行資料", grounded: true, kind: "answer", sourceIds: ["current:1"] }) }] }] });
  } });
  const sources = JSON.parse(request.instructions.match(/<knowledge>(.*)<\/knowledge>/s)[1]);
  assert.equal(sources[0].id, "current:1");
  assert.ok(request.input.some(item => item.role === "assistant"), "keep conversational context; exclude it only from document ranking");
});

async function liveFixture(provider, change, { betweenParts = false } = {}) {
  const db = memoryDb(), store = createStore(db), at = 1000000, key = randomBytes(32).toString("base64"), channelId = "1234567890";
  const documentId = randomUUID(), old = { title: "配送政策", content: "配送時間為五天。", enabled: true }, sent = [];
  await store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true }), at);
  await store.saveAiKnowledge("alice", documentId, old, at);
  let item;
  if (provider === "line") {
    await store.bind("alice", { channelId, ownerUid: "alice", accessToken: seal("test-token", key, channelId + ":access-token") });
    const event = normalizeEvent({ type: "message", webhookEventId: "current-info", timestamp: at,
      source: { type: "user", userId: "U" + "a".repeat(32) }, message: { id: "message-1", type: "text", text: "配送需要多久？" } });
    await store.ingest(channelId, event);
    item = { channelId, conversationId: event.conversationId, messageId: event.messageId };
  } else {
    const profileId = "a".repeat(24), accountId = "b".repeat(24);
    await store.saveZernioProfile("alice", profileId, at);
    await store.bindZernioPlatform("alice", profileId, provider, { accountId, platform: provider }, at);
    item = { uid: "alice", ...await store.ingestZernio("alice", { provider, eventId: randomUUID(), accountId, remoteConversationId: "thread", remoteMessageId: randomUUID(), text: "配送需要多久？", sentAt: at }) };
  }
  const mutate = async () => {
    if (change === "delete") await store.deleteAiKnowledge("alice", documentId, at + 1);
    else if (change === "settings") await store.saveAccountAiSettings("alice", normalizeAiSettings({ enabled: true, businessInfo: "配送時間為兩天。" }), at + 1);
    else await store.saveAiKnowledge("alice", documentId, { ...old, content: change === "disable" ? old.content : "配送時間為兩天。", enabled: change !== "disable" }, at + 1);
  };
  const fetchOpenAi = async () => {
    if (!betweenParts) await mutate();
    return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ action: "reply", text: "依照目前配送政策，我們會於確認訂單後安排配送，配送需要五天，感謝您的耐心等候。\n\n如果您還有其他配送相關的問題，歡迎再次與我們聯絡，客服人員會協助您確認。\n\n謝謝您的支持，我們很樂意繼續為您提供服務，也歡迎您告訴我們其他需要協助的事項。", reason: "配送政策", grounded: true, kind: "answer", sourceIds: [documentId + ":1"] }) }] }] });
  };
  const transport = async (url, options = {}) => {
    if ((url.endsWith("/messages") || /\/message\/(push|reply)$/.test(url)) && options.method === "POST") sent.push(JSON.parse(options.body));
    return Response.json({ messages: [] });
  };
  const config = { store, getKey: () => key, getOpenAiKey: () => "test-key", getZernioKey: () => "test-key", now: () => at, fetchOpenAi,
    fetchLine: transport, fetchZernio: transport, wait: mutate };
  return { store, item, sent, responder: provider === "line" ? createAiResponder(config) : createZernioAiResponder(config) };
}

for (const provider of ["line", "facebook", "instagram"]) {
  for (const change of ["update", "disable", "delete", "settings"]) test(`${provider}: ${change} while generating prevents delivery of the outdated answer`, async () => {
    const f = await liveFixture(provider, change);
    assert.deepEqual(await f.responder(f.item), { skipped: true });
    assert.equal(f.sent.length, 0);
    assert.equal((await f.store.aiLogs("alice")).items[0].status, "skipped");
  });
}
for (const provider of ["facebook", "instagram"]) test(`${provider}: knowledge update between bubbles stops the remaining outdated text`, async () => {
  const f = await liveFixture(provider, "update", { betweenParts: true });
  assert.deepEqual(await f.responder(f.item), { skipped: true });
  assert.equal(f.sent.length, 1);
  assert.equal((await f.store.aiLogs("alice")).items[0].sentParts, 1);
});
