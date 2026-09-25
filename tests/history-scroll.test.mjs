import test from 'node:test';
import assert from 'node:assert/strict';
import { watchHistoryScroll } from '../public/history-scroll.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(load = async () => {}) {
  const events = {}, area = { scrollTop: 200, addEventListener(name, fn) { events[name] = fn; } };
  let allowed = true, calls = 0, errors = 0;
  const control = watchHistoryScroll(area, { canLoad: () => allowed, load: async () => { calls++; await load(); }, onError: () => errors++ });
  return { area, control, calls: () => calls, errors: () => errors, allow: value => { allowed = value; },
    scroll(top) { area.scrollTop = top; events.scroll(); }, wheel(deltaY) { events.wheel({ deltaY }); } };
}
test('upward scrolling near the top loads history, downward scrolling does not', async () => {
  const f = fixture(); f.scroll(100); assert.equal(f.calls(), 0);
  f.scroll(20); await tick(); assert.equal(f.calls(), 1);
  f.scroll(22); await tick(); assert.equal(f.calls(), 1);
});
test('fast wheel and scroll events share a single in-flight history request', async () => {
  let release; const f = fixture(() => new Promise(resolve => { release = resolve; }));
  f.scroll(0); f.wheel(-100); f.scroll(0); f.wheel(-100);
  assert.equal(f.calls(), 1); release(); await tick();
  f.allow(false); f.wheel(-100); assert.equal(f.calls(), 1);
});
test('failed requests can be retried by scrolling upward at the top', async () => {
  const f = fixture(async () => { throw Error('network'); });
  f.scroll(0); await tick(); assert.equal(f.errors(), 1);
  f.wheel(-1); await tick(); assert.equal(f.calls(), 2); assert.equal(f.errors(), 2);
});
test('restoring the viewport anchor never triggers another page and exhausted history stops', async () => {
  const f = fixture(); f.area.scrollTop = 0; f.control.sync(); f.scroll(0);
  assert.equal(f.calls(), 0);
  f.allow(false); f.wheel(-10); f.scroll(-1); assert.equal(f.calls(), 0);
});
test('an upward wheel loads short pages without scroll movement', async () => {
  const f = fixture(); f.area.scrollTop = 0; f.control.sync(); f.wheel(10); assert.equal(f.calls(), 0);
  f.wheel(-10); await tick(); assert.equal(f.calls(), 1);
});
