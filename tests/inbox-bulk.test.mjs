import test from "node:test";
import assert from "node:assert/strict";
import { bulkAiInput, runBulkAi } from "../public/inbox-bulk.js";

const item = (id, provider = "line") => ({ id, provider, remoteId: `remote-${id}`, ai: { control: { mode: "auto", revision: 3 }, state: { allowed: true } } });
const statusError = status => Object.assign(new Error(`Failure ${status}`), { status });

test("bulk writes preserve provider IDs and the displayed revision", () => {
  assert.deepEqual(bulkAiInput(item("line-id"), "human"), { provider: "line", conversationId: "line-id", mode: "human", revision: 3 });
  for (const provider of ["facebook", "instagram"]) assert.deepEqual(bulkAiInput(item("hash", provider), "auto"), { provider, conversationId: "remote-hash", mode: "auto", revision: 3 });
  const legacy = item("legacy"); delete legacy.ai.control.revision;
  assert.equal(bulkAiInput(legacy, "human").revision, 0, "legacy controls use the same zero revision as the existing single-item API");
});

test("bulk changes cannot bypass missing state, global disable or unsupported actions", () => {
  assert.throws(() => bulkAiInput({ id: "a" }, "human"), /尚未載入/);
  for (const reason of ["AI 自動回覆已關閉", "此渠道未啟用 AI"]) {
    const value = item("a"); value.ai.state.reason = reason;
    assert.throws(() => bulkAiInput(value, "auto"), /先在設定/);
  }
  assert.throws(() => bulkAiInput(item("a"), "delete"), /不支援/);
  const scheduled = item("scheduled"); scheduled.ai.state = { allowed: false, reason: "目前不在 AI 回覆時段" };
  assert.equal(bulkAiInput(scheduled, "auto").mode, "auto");
});

test("bulk requests run at most two concurrently and deduplicate selections", async () => {
  let active = 0, maximum = 0;
  const saved = [], progress = [];
  const results = await runBulkAi([item("a"), item("b"), item("a"), item("c")], "human", async input => {
    active++; maximum = Math.max(maximum, active); saved.push(input.conversationId);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return { control: { mode: "human", revision: 4 }, state: { allowed: false } };
  }, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(maximum, 2); assert.deepEqual(saved.sort(), ["a", "b", "c"]);
  assert.equal(results.filter(result => result.ok).length, 3);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

test("partial failure keeps successful results and never retries a conflicting write", async () => {
  const calls = [], notices = [];
  const results = await runBulkAi([item("a"), item("b"), item("c")], "auto", async input => {
    calls.push(input.conversationId);
    if (input.conversationId === "b") throw statusError(409);
    return { control: { mode: "auto", revision: 4 }, state: { allowed: true } };
  }, { onResult: result => notices.push(result) });
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.deepEqual(results.map(result => result.ok), [true, false, true]);
  assert.equal(notices.filter(result => !result.ok)[0].id, "b");
});

test("rate limit or expired login stops remaining queued writes", async () => {
  for (const status of [401, 403, 429]) {
    const calls = [];
    const results = await runBulkAi([item("a"), item("b"), item("c"), item("d")], "human", async input => {
      calls.push(input.conversationId); throw statusError(status);
    });
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(results.filter(result => result.pending).length, 2);
    assert.equal(results.some(result => result.ok), false);
  }
});

test("account switch stops queued requests and suppresses stale UI callbacks", async () => {
  let current = true, notices = 0;
  const releases = [], calls = [];
  const pending = runBulkAi([item("a"), item("b"), item("c")], "human", async input => {
    calls.push(input.conversationId);
    await new Promise(resolve => releases.push(resolve));
    return { control: { mode: "human" }, state: { allowed: false } };
  }, { isCurrent: () => current, onResult: () => notices++, onProgress: () => notices++ });
  current = false; releases.forEach(resolve => resolve());
  const results = await pending;
  assert.deepEqual(calls, ["a", "b"]); assert.equal(notices, 0); assert.equal(results[2].pending, true);
});

test("invalid selection is reported without sending a request and other items can succeed", async () => {
  const calls = [];
  const result = await runBulkAi([{ id: "unknown" }, item("valid")], "human", async input => { calls.push(input.conversationId); return {}; });
  assert.deepEqual(calls, ["valid"]); assert.equal(result[0].ok, false); assert.equal(result[1].ok, true);
  assert.deepEqual(await runBulkAi([], "human", async () => assert.fail("No work")), []);
});
