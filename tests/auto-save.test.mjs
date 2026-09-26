import test from "node:test";
import assert from "node:assert/strict";
import { createAutoSave } from "../public/auto-save.js";

test("slow writes serialize newer edits and cannot acknowledge them early", async () => {
  let value = "first", release; const writes = [], states = [];
  const saver = createAutoSave({ read: () => value, state: x => states.push(x), write: async x => {
    writes.push(x); if (x === "first") await new Promise(resolve => { release = resolve; });
  } });
  saver.change(); const job = saver.flush(); value = "latest"; saver.change();
  assert.equal(saver.pending(), true); assert.deepEqual(writes, ["first"]);
  release(); assert.equal(await job, true); assert.deepEqual(writes, ["first", "latest"]);
  assert.equal(states.at(-1).pending, false); saver.dispose();
});
test("failed writes retain changes and can be retried", async () => {
  let attempts = 0; const saver = createAutoSave({ read: () => "draft", write: async () => { if (++attempts === 1) throw Error("offline"); } });
  saver.change(); assert.equal(await saver.flush(), false); assert.equal(saver.pending(), true);
  assert.equal(await saver.flush(), true); assert.equal(saver.pending(), false); saver.dispose();
});
test("incomplete fields wait until valid without sending partial knowledge", async () => {
  let value = "", writes = 0; const saver = createAutoSave({ read: () => value, valid: x => !!x, write: async () => { writes++; } });
  saver.change(); assert.equal(await saver.flush(), false); assert.equal(writes, 0);
  value = "complete"; saver.change(); await saver.flush(); assert.equal(writes, 1); saver.dispose();
});
test("IME composition is never flushed as an intermediate value", async () => {
  let writes = 0; const saver = createAutoSave({ read: () => "中文", write: async () => { writes++; } });
  saver.pause(); assert.equal(await saver.flush(), false); assert.equal(writes, 0);
  saver.resume(); await saver.flush(); assert.equal(writes, 1); saver.dispose();
});
test("session disposal suppresses stale acknowledgements and queued writes", async () => {
  let finish, writes = 0, notifications = 0;
  const saver = createAutoSave({ read: () => "value", state: () => notifications++, write: () => { writes++; return new Promise(r => { finish = r; }); } });
  saver.change(); const job = saver.flush(); saver.change(); saver.dispose(); const before = notifications;
  finish(); await job; assert.equal(writes, 1); assert.equal(notifications, before);
});
test("rapid edits debounce into a single request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let writes = 0; const saver = createAutoSave({ read: () => "latest", write: async () => { writes++; } });
  saver.change(); t.mock.timers.tick(500); saver.change(); t.mock.timers.tick(500); assert.equal(writes, 0);
  t.mock.timers.tick(200); await saver.flush(); assert.equal(writes, 1); saver.dispose();
});
