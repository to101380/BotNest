import test from "node:test";
import assert from "node:assert/strict";
import { createAdminUsers, createAdminStore, publicAdminUser } from "../admin-users.js";
import { createStore } from "../store.js";
import { createHandler } from "../core.js";
import { memoryDb } from "./memory.js";
import { MONITOR_GOOGLE_ID } from "../security-monitor.js";
const now = 1790856000000;
const admin = { uid: "owner", auth_time: now / 1000, firebase: { sign_in_provider: "google.com", identities: { "google.com": [MONITOR_GOOGLE_ID] } } };
function fixture({ actor = admin, failure = false, target = {} } = {}) {
  const db = memoryDb(); db.getAll = (...refs) => Promise.all(refs.map(r => r.get()));
  const calls = [];
  const user = { uid: "alice", email: "alice@example.test", providerData: [{ providerId: "password" }], ...target };
  const auth = { verifyIdToken: async (_, revoked) => { assert.equal(revoked, true); return actor; }, listUsers: async (limit, cursor) => { calls.push(["list", limit, cursor]); return { users: [user], pageToken: "next" }; }, getUser: async () => user,
    updateUser: async (uid, value) => { calls.push(["update", uid, value]); if (failure) throw Error("private failure"); }, revokeRefreshTokens: async uid => calls.push(["revoke", uid]) };
  const store = createAdminStore(db), handle = createAdminUsers({ auth, store, now: () => now });
  const invoke = async (method = "GET", body, overrides = {}) => {
    let status = 200, result;
    const req = { url: method === "GET" ? "/api/ai/admin/users" : "/api/ai/admin/access", method, body, get: name => ({ authorization: "Bearer test", origin: "https://planning-with-ai-52d58.web.app" })[name], ...overrides };
    await handle(req, { set() {}, status(value) { status = value; return this; }, json(value) { result = value; } });
    return { status, result };
  };
  return { db, store, invoke, calls };
}
test("admin rejects unsigned, spoofed and non-Google identities before reading users", async () => {
  for (const actor of [null, { uid: MONITOR_GOOGLE_ID, admin: true }, { ...admin, firebase: { ...admin.firebase, sign_in_provider: "password" } }, { ...admin, firebase: { sign_in_provider: "google.com", identities: { "google.com": ["other"] } } }]) {
    const f = fixture({ actor }); assert.equal((await f.invoke()).status, 403); assert.deepEqual(f.calls, []);
  }
});
test("admin paginates 25 auth users and returns only safe account and usage fields", async () => {
  const f = fixture(); f.db.data.set("botnest/state/accounts/alice", { channelId: "channel", access: { disabled: true, revision: 3 }, zernio: { instagram: { accountId: "ig", displayName: "Shop" }, secret: "secret" } });
  f.db.data.set("botnest/state/channels/channel", { ownerUid: "alice", displayName: "LINE Shop", accessToken: "secret" });
  const response = await f.invoke(); assert.equal(response.status, 200); assert.deepEqual(f.calls, [["list", 25, undefined]]);
  assert.equal(response.result.next, "next"); assert.equal(response.result.items[0].platforms.length, 2); assert.equal(response.result.items[0].disabled, true);
  assert.ok(!JSON.stringify(response.result).includes("secret")); assert.equal(response.result.items[0].registrationMethod, null); assert.equal(response.result.items[0].plan, null);
});
test("disabled access overrides AI settings, revokes tokens and audits; restore is reversible", async () => {
  const f = fixture(); f.db.data.set("botnest/state/accounts/alice", { ai: { enabled: true, businessInfo: "keep" } });
  assert.equal((await f.invoke("PUT", { uid: "alice", disabled: true, revision: 0 })).status, 200);
  const store = createStore(f.db); assert.equal(await store.isAccountDisabled("alice"), true); assert.equal((await store.accountAiSettings("alice")).enabled, false);
  assert.ok(f.calls.some(c => c[0] === "revoke")); assert.equal((await f.invoke("PUT", { uid: "alice", disabled: false, revision: 1 })).status, 200);
  assert.equal(await store.isAccountDisabled("alice"), false); assert.equal((await store.accountAiSettings("alice")).enabled, true);
  assert.equal([...f.db.data.keys()].filter(k => k.includes("adminAudit")).length, 2);
});
test("stale revisions and protected administrators cannot be modified", async () => {
  const f = fixture(); assert.equal((await f.invoke("PUT", { uid: "alice", disabled: true, revision: 9 })).status, 409); assert.equal(f.calls.length, 0);
  for (const uid of ["owner", "alice"]) {
    const g = fixture({ target: { providerData: [{ providerId: "google.com", uid: MONITOR_GOOGLE_ID }] } });
    assert.equal((await g.invoke("PUT", { uid, disabled: true, revision: 0 })).status, 403); assert.equal(g.calls.length, 0);
  }
});
test("writes require recent Google authentication, valid body and trusted origin", async () => {
  const stale = fixture({ actor: { ...admin, auth_time: now / 1000 - 601 } }); assert.equal((await stale.invoke("PUT", { uid: "alice", disabled: true, revision: 0 })).status, 403);
  const f = fixture(); assert.equal((await f.invoke("PUT", { uid: "a/b", disabled: true, revision: 0 })).status, 400);
  assert.equal((await f.invoke("PUT", { uid: "alice", disabled: "true", revision: 0 })).status, 400);
  assert.equal((await f.invoke("PUT", { uid: "alice", disabled: true, revision: 0 }, { get: n => n === "authorization" ? "Bearer test" : "https://evil.test" })).status, 403);
});
test("auth synchronization failure remains fail-closed and hides provider errors", async () => {
  const f = fixture({ failure: true }); const response = await f.invoke("PUT", { uid: "alice", disabled: false, revision: 0 });
  assert.equal(response.status, 503); assert.ok(!response.result.error.includes("private"));
  const access = f.db.data.get("botnest/state/accounts/alice").access; assert.equal(access.disabled, true); assert.equal(access.syncError, true); assert.equal(access.pending, null);
});
test("a concurrent operation cannot override an in-progress mutation", async () => {
  const f = fixture(); await f.store.beginAccess("alice", { operation: "one", actor: "owner", disabled: true, revision: 0, at: now });
  await assert.rejects(f.store.beginAccess("alice", { operation: "two", actor: "owner", disabled: false, revision: 1, at: now }), { status: 409 });
});
test("public DTO aggregates actual usage without leaking tokens or asserting an unknown plan", () => {
  const dto = publicAdminUser({ uid: "alice", customClaims: { secret: "no" }, tokensValidAfterTime: "no" }, { usage: { buckets: { line_text: { requests: 2, nanoUsd: 50 }, instagram_image: { requests: 3, images: 3, nanoUsd: 70 } } } });
  assert.equal(dto.usage.requests, 5); assert.equal(dto.usage.nanoUsd, 120); assert.equal(dto.usage.images, 3); assert.ok(!("customClaims" in dto));
});
test("application API rejects suspended users even when their token still verifies", async () => {
  const f = fixture(); f.db.data.set("botnest/state/accounts/alice", { access: { disabled: true } });
  const handler = createHandler({ store: createStore(f.db), verifyToken: async () => ({ uid: "alice", firebase: { sign_in_provider: "google.com" } }), authorizeSession: async () => {}, getKey: () => "" });
  let code = 200; await handler({ url: "/api/line/account", method: "GET", get: () => "Bearer test" }, { set() {}, status(n) { code = n; return this; }, json() {} }); assert.equal(code, 403);
});
