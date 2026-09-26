import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../store.js";
import { memoryDb } from "./memory.js";
import { handleAiApi } from "../ai-api.js";

test("retried draft creation is tenant-scoped and does not overwrite or duplicate", async () => {
  const db = memoryDb(), store = createStore(db), draftId = "11111111-1111-4111-8111-111111111111";
  const create = async (uid, content) => {
    let result; await handleAiApi({ user: { uid }, path: "/api/ai/knowledge", req: { method: "POST", body: { draftId, title: "資料", content, enabled: true }, get: () => undefined }, res: { json: x => { result = x; } }, store, now: () => 1000 }); return result.item;
  };
  const first = await create("alice", "initial"); const retry = await create("alice", "retry");
  assert.equal(first.id, draftId); assert.equal(retry.content, "initial");
  assert.equal((await store.aiKnowledge("alice")).length, 1);
  assert.equal(db.data.get("botnest/state/accounts/alice/limits/knowledge").count, 1);
  assert.equal((await create("bob", "other tenant")).content, "other tenant");
  await store.saveAiKnowledge("alice", draftId, { title: "資料", content: "latest", enabled: true }, 1001);
  assert.equal((await create("alice", "delayed retry")).content, "latest");
  await store.deleteAiKnowledge("alice", draftId, 1002);
  await assert.rejects(create("alice", "resurrect"), /已刪除/);
  await assert.rejects(store.saveAiKnowledge("alice", draftId, { content: "stale" }, 1003), /已刪除/);
  assert.equal((await store.aiKnowledge("alice")).length, 0);
});
