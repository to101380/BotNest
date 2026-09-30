import test from "node:test";
import assert from "node:assert/strict";
import { createImageReply } from "../public/image-reply.js";

function fixture(t, api) {
  const elements = new Map();
  const makeElement = () => ({ hidden: false, disabled: false, value: "", textContent: "", children: [], attributes: {}, listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    getAttribute(name) { return this.attributes[name] ?? null; }, removeAttribute(name) { delete this.attributes[name]; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
    showModal() { this.open = true; }, close() { this.open = false; },
  });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); }, createElement: makeElement };
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => { if (prior) Object.defineProperty(globalThis, "document", prior); else delete globalThis.document; });
  const state = { enabled: true, conversationId: "first", attachment: { id: "image", kind: "image", name: "photo.png", expiresAt: Date.now() + 86400000, imageCard: { title: "", description: "" } } };
  const writes = [], errors = [];
  const ui = createImageReply({ api, context: () => state, setAttachment: value => { writes.push(value); state.attachment = value; }, trustedUrl: () => new URL("https://example.com/image.png"), report: error => errors.push(error) });
  return { ui, state, writes, errors, element: id => document.getElementById(id) };
}

test("an image saved after sign-out cannot repopulate the next account's draft", async t => {
  let finish;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = f.element("line-save-image").listeners.click();
  f.ui.reset(); f.state.conversationId = "next-account"; f.state.attachment = null;
  finish({ ok: true }); await pending;
  assert.deepEqual(f.writes, []); assert.equal(f.state.attachment, null);
  assert.deepEqual(f.element("line-library-grid").children, []);
});

test("failed library requests retain a visible error and can be retried", async t => {
  let calls = 0;
  const f = fixture(t, async () => { if (++calls === 1) throw new Error("offline"); return { items: [], next: null }; });
  f.element("line-image-library").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.element("line-library-state").textContent, /讀取失敗/);
  f.element("line-library-close").listeners.click();
  f.element("line-image-library").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.match(f.element("line-library-state").textContent, /沒有符合/);
});
