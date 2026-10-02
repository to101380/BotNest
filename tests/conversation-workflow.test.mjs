import test from "node:test";
import assert from "node:assert/strict";
import { cleanWorkflow, createWorkflowStore, createWorkflowHandler } from "../functions/conversation-workflow.js";
import { workflowMatches } from "../public/conversation-workflow.js";
import { memoryDb } from "../functions/test/memory.js";
test("workflow persists per account, only assigns self, supports restore and detects conflicts", async () => {
  const store = createWorkflowStore(memoryDb());
  const write = (action, value, revision) => store.save("alice", cleanWorkflow({ id: "conversation", action, value, revision }, "alice"), revision + 1);
  await write("follow", true, 0); await write("assign", true, 1); await write("trash", true, 2);
  const restored = await write("trash", false, 3); assert.equal(restored.assignee, "alice"); assert.equal(restored.followed, true); assert.equal(restored.trashed, false);
  assert.equal((await store.list("bob")).length, 0); assert.equal((await store.list("alice"))[0].revision, 4);
  await assert.rejects(write("complete", true, 0), { status: 409 });
  assert.throws(() => cleanWorkflow({ id: "conversation", action: "assign", value: true, revision: 0, assignee: "bob" }, "alice"));
});
test("trash and completed views do not leak into active filters", () => {
  assert.equal(workflowMatches({ completed: true }, "active", "a"), false);
  assert.equal(workflowMatches({ trashed: true, followed: true }, "followed", "a"), false);
  assert.equal(workflowMatches({ trashed: true }, "trash", "a"), true);
  assert.equal(workflowMatches({ assignee: "a" }, "assigned", "a"), true);
});
test("workflow handler requires authentication and trusted origin", async () => {
  let user = null; const handler = createWorkflowHandler({ db: memoryDb(), verifyToken: async () => user, authorizeSession: async () => {}, accountStore: { isAccountDisabled: async () => false, aiAttempt: async () => {} } });
  const call = async (origin) => { let status = 200; await handler({ method: "PUT", body: { id: "c", action: "follow", value: true, revision: 0 }, get: key => key === "authorization" ? "Bearer fixture" : origin }, { set() {}, status(code) { status = code; return this; }, json() {} }); return status; };
  assert.equal(await call("https://planning-with-ai-52d58.web.app"), 401);
  user = { uid: "a", firebase: { sign_in_provider: "google.com" } }; assert.equal(await call("https://evil.test"), 403); assert.equal(await call("https://planning-with-ai-52d58.web.app"), 200);
});
import { createStore } from '../functions/store.js';
test('new incoming LINE message reopens completed conversation, but duplicates, older messages and unsends do not', async () => {
  const db = memoryDb(), inbox = createStore(db), workflow = createWorkflowStore(db);
  await db.collection('botnest').doc('state').collection('channels').doc('channel').set({ ownerUid: 'alice' });
  const event = { conversationId: 'c', messageId: 'm1', eventId: 'e1', type: 'text', text: 'hi', sentAt: 100, sourceType: 'user', sourceId: 'u' };
  await inbox.ingest('channel', event);
  await workflow.save('alice', cleanWorkflow({ id: 'c', action: 'complete', value: true, revision: 0 }, 'alice'), 200);
  await inbox.ingest('channel', { ...event, eventId: 'duplicate', sentAt: 300 });
  await inbox.ingest('channel', { ...event, messageId: 'old', eventId: 'old', sentAt: 150 });
  await inbox.ingest('channel', { ...event, messageId: 'unsent', eventId: 'unsent', sentAt: 300, unsent: true });
  assert.equal((await workflow.list('alice'))[0].completed, true);
  await inbox.ingest('channel', { ...event, messageId: 'new', eventId: 'new', sentAt: 301 });
  const reopened = (await workflow.list('alice'))[0];
  assert.equal(reopened.completed, false); assert.equal(reopened.revision, 2);
  assert.equal((await workflow.list('bob')).length, 0);
});
test('Facebook and Instagram incoming messages reopen account-scoped workflow', async () => {
  for (const platform of ['facebook', 'instagram']) {
    const db = memoryDb(), inbox = createStore(db), workflow = createWorkflowStore(db);
    const event = { provider: platform, accountId: 'a', remoteConversationId: 'c', remoteMessageId: 'm', eventId: 'e', sentAt: 300, text: 'hi', displayName: 'Customer', pictureUrl: '' };
    const hash = (await import('node:crypto')).createHash('sha256').update('a:c').digest('hex');
    await workflow.save('alice', cleanWorkflow({ id: `${platform}-${hash}`, action: 'complete', value: true, revision: 0 }, 'alice'), 200);
    await inbox.ingestZernio('alice', event);
    assert.equal((await workflow.list('alice'))[0].completed, false);
  }
});
