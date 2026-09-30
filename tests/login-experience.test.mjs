import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../public/login-experience.js', import.meta.url), 'utf8');
function fixture() {
  const callbacks = [], nodes = new Map();
  function node(id, attributes = {}) {
    const item = { textContent: '', dataset: {}, hidden: false, attributes, listeners: {},
      getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value; },
      addEventListener: (event, fn) => { item.listeners[event] = fn; } };
    nodes.set(id, item); return item;
  }
  for (const id of ['auth-demo-source','auth-demo-question','auth-demo-answer','title','intro','tabs']) node(id);
  const panel = node('signed-out'); panel.querySelector = () => nodes.get('intro');
  node('mode-login', { 'aria-pressed': 'true' }); node('mode-register', { 'aria-pressed': 'false' });
  const buttons = ['line','facebook','instagram'].map(key => { const b = node(key); b.dataset.demoChannel = key; return b; });
  let authenticated = false;
  const document = { querySelectorAll: () => buttons, querySelector: () => nodes.get('tabs'),
    getElementById: id => { assert.ok(nodes.has(id), `Unexpected DOM access: ${id}`); return nodes.get(id); },
    body: { classList: { contains: () => authenticated } } };
  vm.runInNewContext(code, { document, MutationObserver: class { constructor(callback) { callbacks.push(callback); } observe() {} } });
  return { nodes, buttons, panel, update: () => callbacks.forEach(fn => fn()), authenticated: value => { authenticated = value; } };
}
test('channel examples update one selected control and never access credential fields or network APIs', () => {
  const f = fixture();
  for (const button of f.buttons) {
    button.listeners.click();
    assert.equal(f.buttons.filter(x => x.getAttribute('aria-pressed') === 'true').length, 1);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.ok(f.nodes.get('auth-demo-source').textContent.startsWith('透過 '));
    assert.ok(f.nodes.get('auth-demo-answer').textContent.length > 10);
  }
});
test('headings follow login, registration and reset while leaving authenticated views alone', () => {
  const f = fixture(), heading = f.nodes.get('title');
  assert.equal(heading.textContent, '歡迎回來');
  f.nodes.get('mode-login').setAttribute('aria-pressed', 'false');
  f.nodes.get('mode-register').setAttribute('aria-pressed', 'true'); f.update();
  assert.equal(heading.textContent, '從這裡開始');
  f.nodes.get('mode-register').setAttribute('aria-pressed', 'false'); f.update();
  assert.equal(heading.textContent, '重設密碼');
  f.authenticated(true); heading.textContent = '帳號'; f.update();
  assert.equal(heading.textContent, '帳號');
  f.authenticated(false); f.panel.hidden = true; f.update();
  assert.equal(heading.textContent, '帳號');
});
