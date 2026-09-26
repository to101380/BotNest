import test from "node:test";
import assert from "node:assert/strict";
import { matchesName, inboxMode, filterConversations } from "../public/inbox-filters.js";
import { attachInboxAi } from "../functions/inbox-ai.js";

test("name search supports partial characters, aliases, case and full-width input", () => {
  const item = { displayName: "Bian Ruo Ting", customer: { name: "黃韋博" } };
  for (const query of ["黃博", "韋", "ＢＩＡＮ", "ruo ting", "b r t", ""]) assert.equal(matchesName(item, query), true, query);
  assert.equal(matchesName(item, "不存在"), false);
  assert.equal(matchesName({}, "abc"), false);
});
test("filters combine names with actual AI state and do not guess missing state", () => {
  const ai = (mode, allowed, reason = "") => ({ control: { mode }, state: { allowed, reason } });
  const items = [ { displayName: "黃一", ai: ai("auto", true) }, { displayName: "黃二", ai: ai("human", false) }, { displayName: "李三", ai: ai("off", false) }, { displayName: "黃四" } ];
  assert.equal(filterConversations(items, "黃", "auto").length, 1);
  assert.equal(filterConversations(items, "黃", "all").length, 3);
  assert.equal(inboxMode(ai("auto", false, "真人已回覆，AI 暫停中")), "human");
  assert.equal(inboxMode(ai("human", false, "AI 自動回覆已關閉")), "off");
  assert.equal(inboxMode(ai("auto", false, "目前不在 AI 回覆時段")), "off");
  assert.equal(inboxMode(), "unknown");
});
test("list enrichment uses tenant and provider-scoped control IDs", async () => {
  const seen = [], store = { accountAiSettings: async uid => { assert.equal(uid, "alice"); return { enabled: true }; }, aiControl: async (...args) => { seen.push(args); return { mode: args[1] === "facebook" ? "human" : "auto" }; } };
  const line = [{ id: "linehash" }], social = [{ id: "facebook-socialhash" }];
  await attachInboxAi(store, "alice", line, "line", 1); await attachInboxAi(store, "alice", social, "facebook", 1);
  assert.deepEqual(seen, [["alice", "line", "linehash"], ["alice", "facebook", "socialhash"]]);
  assert.equal(inboxMode(line[0].ai), "auto"); assert.equal(inboxMode(social[0].ai), "human");
});
