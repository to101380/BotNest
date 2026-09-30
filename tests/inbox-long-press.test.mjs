import test from 'node:test';
import assert from 'node:assert/strict';
import { installConversationLongPress } from '../public/inbox-long-press.js';

function fixture() {
  const surface = () => {
    const listeners = new Map();
    return { addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); }, emit(k, e = {}) { listeners.get(k)?.(e); } };
  };
  const view = surface(), doc = Object.assign(surface(), { defaultView: view });
  const row = { isConnected: true, dataset: { conversationId: 'customer-1' }, closest() { return this; } };
  const root = Object.assign(surface(), { ownerDocument: doc, contains: el => el === row });
  let now = 0, next = 0, enabled = true;
  const timers = new Map(), selected = [];
  const api = installConversationLongPress(root, { enabled: () => enabled, select: id => selected.push(id), schedule(fn, ms) { timers.set(++next, { fn, due: now + ms }); return next; }, unschedule: id => timers.delete(id) });
  const tick = ms => { now += ms; for (const [id, t] of [...timers]) if (t.due <= now) { timers.delete(id); t.fn(); } };
  const event = extra => ({ target: row, button: 0, pointerId: 1, isPrimary: true, clientX: 10, clientY: 10, detail: 1, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  return { root, doc, view, row, api, selected, tick, event, disable() { enabled = false; }, down(extra) { doc.emit('pointerdown', event(extra)); } };
}

test('short clicks open normally; holding 500ms selects once and consumes release click', () => {
  const f = fixture(); f.down(); f.tick(499); assert.deepEqual(f.selected, []);
  f.doc.emit('pointerup', f.event()); f.tick(1); const short = f.event(); f.doc.emit('click', short); assert.ok(!short.prevented);
  f.down(); f.tick(500); assert.deepEqual(f.selected, ['customer-1']); f.tick(1000); assert.equal(f.selected.length, 1);
  f.doc.emit('pointerup', f.event()); const release = f.event({ target: {} }); f.doc.emit('click', release); assert.ok(release.prevented && release.stopped);
  f.down(); f.doc.emit('pointerup', f.event()); const next = f.event(); f.doc.emit('click', next); assert.ok(!next.prevented);
});

test('scrolling, movement, cancellation, backgrounding and disposal cancel pending selection', () => {
  for (const cancel of [f => f.doc.emit('pointermove', f.event({ clientY: 22 })), f => f.doc.emit('pointercancel', f.event()), f => f.doc.emit('scroll'), f => f.view.emit('blur'), f => f.doc.emit('visibilitychange'), f => f.api.reset(), f => f.api.dispose()]) {
    const f = fixture(); f.down(); f.tick(250); cancel(f); f.tick(500); assert.deepEqual(f.selected, []);
  }
});

test('right click, second pointer, disabled or detached rows cannot enter selection', () => {
  for (const prepare of [f => f.down({ button: 2 }), f => f.down({ isPrimary: false }), f => { f.row.disabled = true; f.down(); }, f => { f.down(); f.row.isConnected = false; }, f => { f.down(); f.disable(); }]) {
    const f = fixture(); prepare(f); f.tick(500); assert.deepEqual(f.selected, []);
  }
});

test('keyboard shortcut selects; keyboard clicks are never swallowed by touch guard', () => {
  const f = fixture(), key = f.event({ shiftKey: true, code: 'Space' }); f.root.emit('keydown', key);
  assert.ok(key.prevented); assert.deepEqual(f.selected, ['customer-1']);
  f.down(); f.tick(500); const click = f.event({ detail: 0 }); f.doc.emit('click', click); assert.ok(!click.prevented);
  f.doc.emit('pointerup', f.event()); f.tick(700); const later = f.event(); f.doc.emit('click', later); assert.ok(!later.prevented);
});

test('native touch context menu triggers selection and prevents the callout', () => {
  const f = fixture(); f.down(); const menu = f.event(); f.root.emit('contextmenu', menu);
  assert.ok(menu.prevented); f.tick(500); assert.deepEqual(f.selected, ['customer-1']);
});
