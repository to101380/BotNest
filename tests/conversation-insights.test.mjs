import test from "node:test";
import assert from "node:assert/strict";
import { insightRange } from "../public/conversation-insights.js";
import { analyzeConversation } from "../functions/conversation-insights.js";
test("summary range splits sessions, caps input, and excludes failed/retracted messages", () => {
  const items = [{ id: "old", sentAt: 1, text: "old", direction: "incoming" }, { id: "new", sentAt: 90000000, text: "new", direction: "incoming" }, { id: "failed", sentAt: 90000001, text: "failed", direction: "outgoing", status: "failed" }];
  assert.deepEqual(insightRange(items).messages.map(m => m.id), ["new"]);
  assert.equal(insightRange(items, "day", 200000000).messages.length, 0);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, sentAt: i + 1, direction: "incoming", text: "a".repeat(2000) }));
  const range = insightRange(many); assert.equal(range.limited, true); assert.ok(range.messages.reduce((n, m) => n + m.text.length, 0) <= 24000);
});
test("analysis validates input and removes invented source IDs", async () => {
  await assert.rejects(analyzeConversation({ messages: [] }), { status: 400 });
  let body;
  const result = await analyzeConversation({ messages: [{ id: "one", direction: "incoming", text: "何時出貨" }], getOpenAiKey: () => "fixture", fetchOpenAi: async (url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ emotions: ["疑惑"], reason: "詢問出貨", need: "出貨日期", progress: "待查詢", next: "查詢訂單", sourceIds: ["one", "invented"] }) }] }] }) }; } });
  assert.equal(body.store, false); assert.deepEqual(result.sourceIds, ["one"]);
});
