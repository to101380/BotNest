import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createLoginSecurity, createLoginSecurityStore, createLoginMailer, LOGIN_ORIGIN } from "../login-security.js";
import { createHandler } from "../core.js";
import { createStore } from "../store.js";
import { memoryDb } from "./memory.js";

function fixture(options = {}) {
  let at = 1800000000000;
  const db = memoryDb(), store = createLoginSecurityStore(db), mails = [];
  const users = { alice: { uid: "alice", email: "alice@example.com", email_verified: true, auth_time: at / 1000, firebase: { sign_in_provider: "password" } },
    bob: { uid: "bob", email: "bob@example.com", email_verified: true, auth_time: at / 1000, firebase: { sign_in_provider: "google.com" } } };
  const verifyToken = async token => { if (!users[token]) throw new Error("bad-token"); return { ...users[token] }; };
  const service = createLoginSecurity({ store, verifyToken, now: () => at, sendMail: async mail => { mails.push(mail); if (options.mailFailure) throw new Error("mail-error"); }, mailReady: () => options.ready !== false });
  function req(path, { user = "alice", method = "GET", body, cookie = "", headers = {} } = {}) {
    const all = { authorization: `Bearer ${user}`, origin: LOGIN_ORIGIN, "content-type": "application/json", "user-agent": "Mozilla Windows Chrome/140", cookie, ...headers };
    return { originalUrl: path, method, body, ip: "203.0.113.7", get: name => all[name.toLowerCase()] };
  }
  const response = () => ({ code: 200, headers: {}, set(k,v) { this.headers[k] = v; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  async function call(path, input = {}) { const res = response(); await service.handle(req(`/api/login-security/${path}`, input), res); return res; }
  async function begin(input = {}) { const result = await call("session", { method: "POST", body: {}, ...input }); return { ...result, cookie: result.headers["Set-Cookie"]?.split(";")[0] || input.cookie }; }
  const ticket = (index = mails.length - 1) => mails[index].url.split("#")[1];
  const decide = (value = ticket(), decision = "approve") => call("decision", { method: "POST", body: { ticket: value, decision }, user: "invalid" });
  async function approved(input = {}) { const result = await begin(input); assert.equal(result.code, 200); assert.equal((await decide()).code, 200); return result; }
  return { db, store, service, mails, users, req, response, call, begin, ticket, decide, approved,
    advance(ms) { at += ms; }, fresh(user = "alice") { users[user].auth_time = at / 1000; }, now: () => at,
    core: createHandler({ store: createStore(db), verifyToken, authorizeSession: service.authorize, getKey: () => randomBytes(32).toString("base64"), now: () => at }), options };
}

test("new device is denied by all business API families until explicit email approval", async () => {
  const f = fixture(), result = await f.begin();
  assert.equal(result.body.state, "pending"); assert.equal(result.body.access, false);
  assert.match(result.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].to, "alice@example.com");
  for (const path of ["/api/line/account", "/api/ai/settings", "/api/zernio/account"]) {
    const res = f.response(); await f.core(f.req(path, { cookie: result.cookie }), res); assert.equal(res.code, 403, path);
  }
  assert.equal((await f.call("overview", { cookie: result.cookie })).code, 403);
  assert.equal((await f.call("review", { method: "POST", body: { ticket: f.ticket() } })).code, 200);
  await assert.rejects(f.service.authorize(f.req("/", { cookie: result.cookie }), f.users.alice));
  assert.equal((await f.decide()).code, 200);
  await f.service.authorize(f.req("/", { cookie: result.cookie }), f.users.alice);
  const res = f.response(); await f.core(f.req("/api/line/account", { cookie: result.cookie }), res); assert.equal(res.code, 200);
});

test("approval is single-use, atomic under concurrent decisions, and cannot approve another device", async () => {
  const f = fixture(), first = await f.begin(), ticket = f.ticket();
  const decisions = await Promise.all([f.decide(ticket), f.decide(ticket, "deny")]);
  assert.deepEqual(decisions.map(r => r.code).sort(), [200, 410]);
  assert.equal((await f.decide(ticket)).code, 410);
  f.advance(61000); f.fresh(); const second = await f.begin();
  assert.notEqual(first.cookie, second.cookie);
  assert.equal(second.body.access, false);
  assert.equal((await f.call("overview", { cookie: second.cookie })).code, 403);
});

test("approval expiry, tampering, anonymous read and wrong origins fail closed", async () => {
  const f = fixture(); await f.begin(); const ticket = f.ticket();
  assert.equal((await f.decide(`${ticket.slice(0, -1)}!`)).code, 400);
  const parts = ticket.split("."); parts[2] = randomBytes(32).toString("base64url");
  assert.equal((await f.decide(parts.join("."))).code, 410);
  assert.equal((await f.call("decision", { method: "GET" })).code, 405);
  assert.equal((await f.call("decision", { method: "POST", body: { ticket, decision: "approve" }, headers: { origin: "https://evil.example" } })).code, 403);
  assert.equal((await f.call("decision", { method: "POST", body: { ticket, decision: "approve" }, headers: { "content-type": "text/plain" } })).code, 403);
  assert.equal((await f.call("overview", { user: "invalid" })).code, 401);
  f.advance(15 * 60000); assert.equal((await f.decide(ticket)).code, 410);
});

test("denied login cannot revive itself, deleting a cookie still requires email approval", async () => {
  const f = fixture(), pending = await f.begin(); await f.decide(f.ticket(), "deny");
  assert.equal((await f.begin({ cookie: pending.cookie })).code, 403);
  assert.equal((await f.call("session", { cookie: pending.cookie })).body.state, "denied");
  f.advance(61000); f.fresh(); const cleared = await f.begin();
  assert.equal(cleared.body.access, false); assert.equal(cleared.body.state, "pending");
});

test("overview is tenant isolated and never leaks cookies or approval tokens", async () => {
  const f = fixture(), alice = await f.approved(), bob = await f.approved({ user: "bob" });
  const overview = await f.call("overview", { cookie: alice.cookie });
  assert.equal(overview.body.devices.length, 1); assert.equal(overview.body.devices[0].current, true);
  assert.equal(overview.body.devices[0].network, "203.0.113.*");
  assert.equal((await f.call("overview", { user: "bob", cookie: alice.cookie })).code, 403);
  assert.equal((await f.call("revoke", { method: "POST", cookie: alice.cookie, body: { deviceId: bob.body.deviceId } })).code, 404);
  const serialized = JSON.stringify(overview.body), stored = JSON.stringify([...f.db.data.values()]);
  assert.ok(!serialized.includes("example.com") && !serialized.includes("proofHash") && !serialized.includes('"key"'));
  assert.ok(!stored.includes(alice.cookie.split("=")[1]) && !stored.includes(f.ticket().split(".")[2]));
});

test("revoke-other keeps current device, cancels pending links and blocks replay immediately", async () => {
  const f = fixture(), first = await f.approved();
  f.advance(61000); const second = await f.approved();
  f.advance(61000); const pending = await f.begin(), ticket = f.ticket();
  assert.equal((await f.call("revoke", { method: "POST", cookie: first.cookie, body: { deviceId: "others" } })).code, 200);
  await f.service.authorize(f.req("/", { cookie: first.cookie }), f.users.alice);
  await assert.rejects(f.service.authorize(f.req("/", { cookie: second.cookie }), f.users.alice));
  assert.equal((await f.decide(ticket)).code, 410);
  assert.equal((await f.begin({ cookie: second.cookie })).code, 403);
  assert.equal((await f.call("session", { cookie: pending.cookie })).body.state, "revoked");
});

test("known device can reauthenticate; revoked device must verify again with a fresh auth_time", async () => {
  const f = fixture(), first = await f.approved(); f.advance(61000); f.fresh();
  assert.equal((await f.begin({ cookie: first.cookie })).body.access, true); assert.equal(f.mails.length, 1);
  assert.equal((await f.call("revoke", { method: "POST", cookie: first.cookie, body: { deviceId: first.body.deviceId } })).code, 200);
  f.advance(61000); f.fresh();
  const renewed = await f.begin({ cookie: first.cookie }); assert.equal(renewed.body.access, false); assert.equal(f.mails.length, 2);
});

test("refresh-token issue time is irrelevant; original auth_time, verified email and cookie are required", async () => {
  const f = fixture(), first = await f.approved();
  f.users.alice.iat = f.now() / 1000 + 300;
  await f.service.authorize(f.req("/", { cookie: first.cookie }), f.users.alice);
  await assert.rejects(f.service.authorize(f.req("/"), f.users.alice));
  f.users.alice.email = "changed@example.com";
  await assert.rejects(f.service.authorize(f.req("/", { cookie: first.cookie }), f.users.alice));
  f.users.alice.email_verified = false;
  assert.equal((await f.begin({ cookie: first.cookie })).code, 403);
  f.users.alice.email_verified = true; f.advance(7 * 86400000 + 1);
  assert.equal((await f.begin({ cookie: first.cookie })).code, 401);
});

test("concurrent bootstrap deduplicates mail; account-wide rate limit cannot be bypassed with cookies", async () => {
  const f = fixture(), first = await f.begin();
  const repeated = await Promise.all([f.begin({ cookie: first.cookie }), f.begin({ cookie: first.cookie })]);
  assert.ok(repeated.every(r => r.code === 200)); assert.equal(f.mails.length, 1);
  assert.equal((await f.begin()).code, 429);
  f.advance(61000); await f.begin(); f.advance(61000); await f.begin(); f.advance(61000);
  assert.equal((await f.begin()).code, 429); assert.equal(f.mails.length, 3);
});

test("mail failure never grants access and retry replaces the failed challenge after cooldown", async () => {
  const options = { mailFailure: true }, f = fixture(options), first = await f.begin(), old = f.ticket();
  assert.equal(first.body.mailState, "failed"); assert.equal(first.body.access, false);
  assert.equal((await f.begin({ cookie: first.cookie })).code, 429);
  f.advance(61000); options.mailFailure = false;
  const retry = await f.begin({ cookie: first.cookie }); assert.equal(retry.body.mailState, "sent");
  assert.equal((await f.decide(old)).code, 410); assert.equal((await f.decide()).code, 200);
});

test("unconfigured mail, stale bootstrap and invalid/revoked Firebase token never create an approved device", async () => {
  const f = fixture({ ready: false }); assert.equal((await f.begin()).code, 503); assert.equal(f.mails.length, 0);
  assert.equal((await f.begin({ user: "invalid" })).code, 401);
  f.advance(601000); assert.equal((await f.begin()).code, 401);
});

test("old tokens cannot replace a newer login on a trusted device", async () => {
  const f = fixture(), first = await f.approved(), previous = f.users.alice.auth_time;
  f.advance(61000); f.fresh(); assert.equal((await f.begin({ cookie: first.cookie })).body.access, true);
  f.users.alice.auth_time = previous;
  assert.equal((await f.begin({ cookie: first.cookie })).code, 401);
});

test("business handler fails closed when session verifier was not wired", async () => {
  const f = fixture(), handler = createHandler({ store: createStore(f.db), verifyToken: async () => f.users.alice, getKey: () => "" }), res = f.response();
  await handler(f.req("/api/line/account"), res); assert.equal(res.code, 503);
});

test("mail transport uses fixed Resend endpoint, bounded timeout, idempotency and text-only safe content", async () => {
  let request;
  const mail = createLoginMailer({ config: () => ({ apiKey: "test-only", from: "security@example.com" }), fetchMail: async (url, options) => { request = { url, options }; return { ok: true }; } });
  await mail({ to: "a@example.com", url: `${LOGIN_ORIGIN}/login-approval.html#example`, id: "id", label: "Windows · Chrome", network: "203.0.113.*", at: 1800000000000 });
  assert.equal(request.url, "https://api.resend.com/emails"); assert.equal(request.options.headers["Idempotency-Key"], "login-id");
  const body = JSON.parse(request.options.body); assert.equal(body.html, undefined); assert.match(body.text, /不是我/); assert.deepEqual(body.to, ["a@example.com"]);
  const failure = createLoginMailer({ config: () => ({ apiKey: "test", from: "security@example.com" }), fetchMail: async () => ({ ok: false }) });
  await assert.rejects(failure({ at: 1800000000000 }));
});
