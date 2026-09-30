import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../store.js";
import { memoryDb } from "./memory.js";
import { attachInboxAi } from "../inbox-ai.js";
import { createMetadataCache } from "../metadata-cache.js";

test("30 default AI controls use one sparse query instead of 30 missing document gets", async () => {
  const db = memoryDb(), store = createStore(db), ids = Array.from({ length: 30 }, (_, i) => `conversation-${i}`);
  const controls = await store.aiControls("alice", "line", ids);
  assert.equal(controls.size, 30);
  for (const control of controls.values()) assert.deepEqual(control, { mode: "auto", pausedUntil: 0, revision: 0 });
  assert.deepEqual(db.reads, { documents: 0, queries: 1, returned: 0 });
  assert.equal(db.data.size, 0);
});

test("sparse controls remain fresh, tenant/provider scoped and split beyond 30 IDs", async () => {
  const db = memoryDb(), store = createStore(db), ids = Array.from({ length: 61 }, (_, i) => `c${i}`);
  const prefix = "botnest/state/accounts/";
  db.data.set(`${prefix}alice/aiConversations/line-c0`, { mode: "human", revision: 2, pausedUntil: 5000 });
  db.data.set(`${prefix}bob/aiConversations/line-c1`, { mode: "off", revision: 99 });
  db.data.set(`${prefix}alice/aiConversations/facebook-c1`, { mode: "off", revision: 99 });
  db.data.set(`${prefix}alice/aiConversations/line-unrequested`, { mode: "human", revision: 3 });
  const first = await store.aiControls("alice", "line", [...ids, "c0"]);
  assert.equal(first.size, 61); assert.equal(first.get("c0").mode, "human"); assert.equal(first.get("c1").mode, "auto");
  assert.deepEqual(db.reads, { documents: 0, queries: 3, returned: 1 });
  await store.setAiControl("alice", "line", "c0", { mode: "off" }, 100, 2);
  assert.equal((await store.aiControls("alice", "line", ["c0"])).get("c0").revision, 3);
  const before = db.reads.queries;
  assert.equal((await store.aiControls("alice", "line", [])).size, 0); assert.equal(db.reads.queries, before);
});

test("customer enrichment only reads existing requested customer overrides", async () => {
  const db = memoryDb(), store = createStore(db);
  db.data.set("botnest/state/accounts/alice/zernioCustomers/a", { customer: { name: "Fixture", tags: ["VIP"] } });
  db.data.set("botnest/state/accounts/bob/zernioCustomers/b", { customer: { name: "Other tenant" } });
  const result = await store.zernioCustomers("alice", ["a", "b", "missing"]);
  assert.equal(result.get("a").name, "Fixture"); assert.deepEqual(result.get("b"), {}); assert.deepEqual(result.get("missing"), {});
  assert.deepEqual(db.reads, { documents: 0, queries: 1, returned: 1 });
});

test("list enrichment preserves human handoff and global AI disable", async () => {
  const db = memoryDb(), store = createStore(db);
  db.data.set("botnest/state/accounts/alice", { ai: { enabled: true } });
  await store.setAiControl("alice", "facebook", "a", { mode: "human" }, 10, 0);
  const items = [{ id: "facebook-a" }, { id: "facebook-b" }];
  await attachInboxAi(store, "alice", items, "facebook", 20);
  assert.equal(items[0].ai.state.allowed, false); assert.equal(items[0].ai.control.mode, "human");
  assert.equal(items[1].ai.state.allowed, true);
  db.data.set("botnest/state/accounts/alice", { ai: { enabled: false } });
  await attachInboxAi(store, "alice", items, "facebook", 30);
  assert.equal(items[1].ai.state.allowed, false);
});

test("single knowledge lookup avoids scanning other content and hides tombstones", async () => {
  const db = memoryDb(), store = createStore(db), base = "botnest/state/accounts/alice/aiKnowledge/";
  for (let i = 0; i < 40; i++) db.data.set(`${base}${i}`, { content: "Fixture", deleted: i === 39 });
  assert.equal((await store.aiKnowledgeItem("alice", "0")).content, "Fixture");
  assert.deepEqual(db.reads, { documents: 1, queries: 0, returned: 0 });
  assert.equal(await store.aiKnowledgeItem("alice", "39"), null);
  assert.equal(await store.aiKnowledgeItem("bob", "0"), null);
});

test("avatar cache coalesces requests, expires and isolates scope", async () => {
  let clock = 0, calls = 0, release;
  const get = createMetadataCache({ now: () => clock, ttl: 100, maximum: 2 });
  const load = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = get("alice/facebook/one", load), second = get("alice/facebook/one", load);
  await Promise.resolve(); assert.equal(calls, 1); release("avatar");
  assert.deepEqual(await Promise.all([first, second]), ["avatar", "avatar"]);
  assert.equal(await get("alice/facebook/one", () => { throw Error("Must reuse"); }), "avatar");
  assert.equal(await get("bob/facebook/one", async () => "other"), "other");
  clock = 100;
  assert.equal(await get("alice/facebook/one", async () => "updated"), "updated");
  await get("alice/instagram/one", async () => "ig");
  assert.equal(await get("bob/facebook/one", async () => "evicted"), "evicted");
});

test("avatar cache never retains a failed request", async () => {
  const get = createMetadataCache();
  await assert.rejects(get("one", async () => { throw Error("offline"); }), /offline/);
  assert.equal(await get("one", async () => "recovered"), "recovered");
});

test("account/settings reads coalesce only inside one request and retain ownership checks", async () => {
  const db = memoryDb(), store = createStore(db);
  db.data.set("botnest/state/accounts/alice", { channelId: "one", zernio: { profileId: "a" } });
  db.data.set("botnest/state/channels/one", { ownerUid: "alice", ai: { enabled: true } });
  await store.withReadSnapshot(async () => {
    const [account, social, settings] = await Promise.all([store.account("alice"), store.zernioAccount("alice"), store.accountAiSettings("alice")]);
    assert.equal(account.ownerUid, "alice"); assert.equal(social.profileId, "a"); assert.equal(settings.enabled, true);
  });
  assert.equal(db.reads.documents, 2);
  db.data.set("botnest/state/accounts/alice", { ai: { enabled: false } });
  await store.withReadSnapshot(async () => assert.equal((await store.accountAiSettings("alice")).enabled, false));
  assert.equal(db.reads.documents, 3);
  await Promise.all([
    store.withReadSnapshot(() => Promise.all([store.accountAiSettings("alice"), store.accountAiSettings("alice")])),
    store.withReadSnapshot(() => Promise.all([store.accountAiSettings("alice"), store.accountAiSettings("alice")])),
  ]);
  assert.equal(db.reads.documents, 5, "concurrent requests must not share their snapshots");
  db.data.set("botnest/state/accounts/bob", { channelId: "one" });
  await assert.rejects(store.withReadSnapshot(() => store.account("bob")), /無權/);
});
