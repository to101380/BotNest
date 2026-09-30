import test from "node:test";
import assert from "node:assert/strict";
import { createLoginSecurityPanel } from "../public/login-security.js";

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, fetcher) {
  const elements = new Map();
  const element = () => ({ hidden: true, disabled: false, textContent: "", children: [], listeners: {}, classList: { toggle() {} },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this.listeners[name] = callback; }, focus() {} });
  const document = { hidden: false, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.mock.method(globalThis, "fetch", fetcher);
  t.mock.method(globalThis, "setInterval", () => 123);
  t.mock.method(globalThis, "clearInterval", () => {});
  const access = [], panel = createLoginSecurityPanel({ onAccessChange: () => access.push(panel.allowed), onSignOut: async () => panel.setSession(null) });
  const user = { uid: "alice", email: "alice@example.com", emailVerified: true, getIdToken: async () => "test-only" };
  t.after(() => { panel.setSession(null); if (prior) Object.defineProperty(globalThis, "document", prior); else delete globalThis.document; });
  return { panel, user, access, get: id => document.getElementById(id) };
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("pending login never loads private overview and unverified accounts do not send mail", async t => {
  const calls = [], f = fixture(t, async url => { calls.push(url); return reply({ state: "pending", access: false, mailState: "sent" }); });
  f.panel.setSession({ ...f.user, emailVerified: false }); await settle(); assert.equal(calls.length, 0);
  f.panel.setSession(f.user); await settle();
  assert.deepEqual(calls, ["/api/login-security/session"]); assert.equal(f.panel.allowed, false);
  assert.equal(f.get("login-security-content").hidden, true); assert.match(f.get("login-security-status").textContent, /新裝置尚未核准/);
});

test("a delayed response from the prior account cannot unlock or repopulate a signed-out page", async t => {
  let finish;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  f.panel.setSession(f.user); await settle(); f.panel.setSession(null);
  finish(reply({ state: "active", access: true, deviceId: "old" })); await settle();
  assert.equal(f.panel.allowed, false); assert.equal(f.get("login-security").hidden, true); assert.equal(f.get("login-devices").children.length, 0);
});

test("revocation detected during overview fetch clears private data and access", async t => {
  const f = fixture(t, async url => url.endsWith("session") ? reply({ state: "active", access: true, deviceId: "current" }) : reply({ error: "此裝置已被登出" }, 403));
  f.panel.setSession(f.user); await settle();
  assert.deepEqual(f.access, [true, false]); assert.equal(f.panel.allowed, false);
  assert.equal(f.get("login-security-content").hidden, true); assert.equal(f.get("login-devices").children.length, 0);
});

test("device removal requires inline confirmation and current-device removal signs out", async t => {
  const requests = [], f = fixture(t, async (url, options) => {
    requests.push({ url, options });
    return reply(url.endsWith("session") ? { state: "active", access: true, deviceId: "current" } : url.endsWith("overview") ? { devices: [{ id: "current", current: true, state: "active", label: "Browser", network: "203.0.113.*" }], events: [] } : { ok: true });
  });
  f.panel.setSession(f.user); await settle();
  const button = f.get("login-devices").children[0].children[1]; button.listeners.click();
  assert.equal(f.get("login-revoke-confirm").hidden, false); assert.equal(requests.length, 2);
  f.get("login-revoke-cancel").listeners.click(); assert.equal(requests.length, 2);
  button.listeners.click(); f.get("login-revoke-yes").listeners.click(); await settle();
  assert.equal(requests[2].url, "/api/login-security/revoke"); assert.equal(JSON.parse(requests[2].options.body).deviceId, "current");
  assert.equal(f.panel.allowed, false); assert.equal(f.get("login-security").hidden, true);
});
