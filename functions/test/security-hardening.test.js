import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createHandler } from "../core.js";
import { createStore } from "../store.js";
import { memoryDb } from "./memory.js";

const hash = s => createHash("sha256").update(s).digest("hex");
async function fixture() {
  const db = memoryDb(), store = createStore(db), calls = [];
  let at = 1000000;
  const profileId = "a".repeat(24), accountId = "b".repeat(24);
  await store.saveZernioProfile("alice", profileId, at);
  const handler = createHandler({ store, now: () => at, getKey: () => randomBytes(32).toString("base64"),
    authorizeSession: async () => {}, verifyToken: async token => {
      if (!["alice", "bob"].includes(token)) throw new Error("invalid");
      return { uid: token, auth_time: 1000, firebase: { sign_in_provider: "google.com" } };
    }, getZernioKey: () => "test-server-key", fetchZernio: async url => {
      calls.push(url);
      return Response.json(url.includes("/connect/") ? { authUrl: "https://zernio.com/connect/test" } : { accounts: [{ _id: accountId, platform: "facebook", username: "test" }] });
    } });
  async function request(url, { token = "alice", method = "GET", rawBody, body = {} } = {}) {
    const headers = { authorization: token ? `Bearer ${token}` : "", origin: "https://planning-with-ai-52d58.web.app" };
    const result = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, redirect(code, url) { this.code = code; this.location = url; return this; } };
    await handler({ url, method, body, rawBody, get: key => headers[key.toLowerCase()] }, result);
    return result;
  }
  async function connect() {
    assert.equal((await request("/api/zernio/connect/facebook", { method: "POST" })).code, 200);
    const redirect = new URL(new URL(calls.findLast(url => url.includes("/connect/facebook"))).searchParams.get("redirect_url"));
    return redirect.searchParams.get("state");
  }
  return { db, store, request, connect, calls, profileId, accountId, tick: ms => { at += ms; } };
}

test("OAuth callbacks require a fresh one-use state before any upstream request", async () => {
  const f = await fixture(), state = await f.connect();
  const callback = `/zernio-callback?connected=facebook&profileId=${f.profileId}&accountId=${f.accountId}`;
  const before = f.calls.length;
  const complete = (state, token = "alice") => f.request("/api/zernio/complete", { method: "POST", token, body: { connected: "facebook", profileId: f.profileId, accountId: f.accountId, state } });
  for (const invalid of ["", "z".repeat(43)]) {
    assert.equal((await complete(invalid)).code, 403);
    assert.equal(f.calls.length, before);
  }
  assert.ok(!JSON.stringify([...f.db.data]).includes(state));
  assert.equal((await f.request(callback + "&state=" + state, { token: null })).code, 302);
  assert.equal((await f.store.zernioAccount("alice")).facebook, undefined);
  assert.equal((await complete(state, null)).code, 401);
  assert.equal((await complete(state, "bob")).code, 403);
  assert.equal((await complete(state)).code, 200);
  assert.equal((await complete(state)).code, 403);
  const replacement = await f.connect(); f.tick(600001);
  assert.equal((await complete(replacement)).code, 403);
});

test("OAuth state cannot cross users or platforms and concurrent replay binds only once", async () => {
  const f = await fixture(), state = await f.connect(), stateHash = hash(state);
  await f.store.saveZernioProfile("bob", f.profileId, 1000000);
  await assert.rejects(f.store.bindZernioPlatform("bob", f.profileId, "facebook", { accountId: f.accountId }, 1000000, stateHash), { status: 403 });
  await assert.rejects(f.store.bindZernioPlatform("alice", f.profileId, "instagram", { accountId: f.accountId }, 1000000, stateHash), { status: 403 });
  const results = await Promise.allSettled([1, 2].map(() => f.store.bindZernioPlatform("alice", f.profileId, "facebook", { accountId: f.accountId }, 1000000, stateHash)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});

test("all authenticated business routes share a persistent per-user request limit", async () => {
  const f = await fixture();
  for (let i = 0; i < 120; i++) assert.equal((await f.request("/api/line/account")).code, 200);
  assert.equal((await f.request("/api/line/account")).code, 429);
  assert.equal((await f.request("/api/line/account", { token: "bob" })).code, 200);
  f.tick(60000);
  assert.equal((await f.request("/api/line/account")).code, 200);
});

test("oversized requests and expired login cannot start external account operations", async () => {
  const f = await fixture();
  assert.equal((await f.request("/api/zernio/connect/facebook", { method: "POST", rawBody: Buffer.alloc(8 * 1024 * 1024 + 1) })).code, 413);
  f.tick(600001);
  assert.equal((await f.request("/api/zernio/connect/facebook", { method: "POST" })).code, 401);
  assert.equal(f.calls.length, 0);
});
