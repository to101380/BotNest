import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupBuy, parseOrder } from '../group-buy.js';
import { memoryDb } from './memory.js';

const group = `C${'a'.repeat(32)}`, host = `U${'b'.repeat(32)}`, buyer = `U${'c'.repeat(32)}`;
test('button onboarding binds only the owning channel, then opens, orders and rejects old cards', async () => {
  const f = fixture();
  const tap = (data, userId = host) => { const event = f.event('', userId); event.type = 'postback'; delete event.message; event.postback = { data: `gb:${data}` }; return f.service.process('12345', event, async () => '小美'); };
  const request = await tap('bind');
  const url = request.messages[0].contents.footer.contents[0].action.uri;
  const token = new URL(url).searchParams.get('groupBuyBinding');
  await assert.rejects(f.service.bind('67890', token));
  await f.service.bind('12345', token);
  await assert.rejects(f.service.bind('12345', token));
  await tap('new', buyer); assert.equal((await f.state()).draft, undefined);
  await tap('new'); await f.send('手工水餃'); await f.send('150');
  assert.equal((await f.state()).open, false);
  await tap(`publish:${(await f.state()).draft.nonce}`);
  const round = (await f.state()).roundId;
  const event = f.event('', buyer); event.type = 'postback'; delete event.message; event.postback = { data: `gb:buy:${round}:3` };
  await f.service.process('12345', event); await f.service.process('12345', event);
  assert.equal((await f.state()).orders[buyer].quantity, 3);
  await tap(`end:${round}`, buyer); assert.equal((await f.state()).open, true);
  await tap(`close:${round}`); assert.equal((await f.state()).open, true);
  await tap(`end:${round}`); assert.equal((await f.state()).open, false);
  await tap('new'); await f.send('雞塊'); await f.send('100'); await tap(`publish:${(await f.state()).draft.nonce}`);
  await tap(`buy:${round}:1`, buyer); assert.equal((await f.state()).orders[buyer], undefined);
});
function fixture(options = {}) {
  const db = memoryDb(); let clock = 1000000, serial = 0;
  db.data.set('botnest/state/channels/12345', { ownerUid: 'seller' });
  const service = createGroupBuy(db, { now: () => clock, ...options });
  const event = (text, userId = host) => ({ type: 'message', webhookEventId: `event-${++serial}`, timestamp: ++clock,
    source: { type: 'group', groupId: group, userId }, message: { type: 'text', id: String(serial), text } });
  const send = (text, userId) => service.process('12345', event(text, userId), async () => userId === buyer ? '小美' : '團主');
  const start = async () => { const code = await service.activation('12345'); await send(code.command); await send('/開團 水餃 150'); };
  return { db, service, event, send, start, state: () => service.snapshot('12345', group) };
}
test('natural quantity rules reject questions, negation and mixed specifications', () => {
  for (const [text, quantity] of [['+1', 1], ['＋２', 2], ['我也要1份', 1], ['我要三組', 3], ['我要十二份', 12], ['追加2包', 2]]) assert.deepEqual(parseOrder(text), { action: 'add', quantity });
  assert.deepEqual(parseOrder('改成2包'), { action: 'set', quantity: 2 });
  for (const text of ['我不要1份', '我要三組嗎？', '紅兩個藍一個', '我想問1份多少錢', '三個人都要', '+1 +2']) assert.equal(parseOrder(text), null);
  assert.equal(parseOrder('+100').action, 'invalid');
});
test('activation is scoped, one-use, and non-host cannot open or close rounds', async () => {
  const f = fixture(), code = await f.service.activation('12345');
  assert.match((await f.service.process('67890', f.event(code.command))).text, /失效/);
  assert.equal(await f.service.snapshot('67890', group), null);
  await f.send(code.command); await f.send('/開團 水餃 150', buyer);
  assert.equal((await f.state()).open, false);
  const other = { ...f.event(code.command), source: { type: 'group', groupId: `C${'d'.repeat(32)}`, userId: host } };
  assert.match((await f.service.process('12345', other)).text, /失效/);
});
test('isolated buyers, redelivery deduplication, changes, cancellation and archives', async () => {
  const f = fixture(); await f.start();
  await f.send('+1', buyer); await f.send('我要三組', buyer);
  assert.equal((await f.state()).orders[buyer].quantity, 4);
  assert.equal((await f.state()).orders[buyer].label, '小美');
  const event = f.event('+2', buyer);
  await Promise.all([f.service.process('12345', event), f.service.process('12345', { ...event, deliveryContext: { isRedelivery: true } })]);
  assert.equal((await f.state()).orders[buyer].quantity, 6);
  await f.send('改成2份', buyer); await f.send('+1', host);
  assert.equal((await f.state()).orders[buyer].quantity, 2); assert.equal((await f.state()).orders[host].quantity, 1);
  await f.send('/結團', buyer); assert.equal((await f.state()).open, true);
  await f.send('取消訂單', buyer); assert.equal((await f.state()).orders[buyer].quantity, 0);
  await f.send('/結團'); await f.send('+1', buyer); assert.equal((await f.state()).orders[buyer].quantity, 0);
  const old = (await f.state()).roundId; await f.send('/開團 雞塊 100');
  assert.deepEqual((await f.state()).orders, {});
  assert.ok([...f.db.data.keys()].some(path => path.endsWith(`/rounds/${old}`)));
});
test('AI proposal never commits until confirmed and chat cannot invent orders', async () => {
  let calls = 0;
  const f = fixture({ getOpenAiKey: () => 'test', fetchOpenAi: async () => { calls++; return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"action":"add","quantity":2}' }] }] }) }; } });
  await f.start();
  await f.send('幫我留兩份吧', buyer);
  assert.equal((await f.state()).orders[buyer], undefined);
  assert.equal((await f.state()).pending[buyer].intent.quantity, 2);
  await f.send('/確認', buyer); assert.equal((await f.state()).orders[buyer].quantity, 2);
  await f.send('/確認', buyer); assert.equal((await f.state()).orders[buyer].quantity, 2);
  await f.send('你好', buyer); assert.equal(calls, 1);
  await f.send('幫我留兩份吧', buyer); await f.send('/放棄', buyer); await f.send('/確認', buyer);
  assert.equal((await f.state()).orders[buyer].quantity, 2);
});
test('previously enabled groups turn off customer AI on next message without losing orders', async () => {
  const f = fixture(); await f.start(); await f.send('+2', buyer);
  const entry = [...f.db.data.entries()].find(([path]) => /\/groupBuys\/[^/]+$/.test(path));
  const state = entry[1]; delete state.customerAiDisabledAt; f.db.data.set(entry[0], state);
  const controlPath = [...f.db.data.keys()].find(path => path.includes('/aiConversations/'));
  f.db.data.set(controlPath, { mode: 'auto', revision: 3 });
  await f.send('早安', buyer);
  assert.equal(f.db.data.get(controlPath).mode, 'off'); assert.equal(f.db.data.get(controlPath).revision, 4);
  assert.equal((await f.state()).orders[buyer].quantity, 2);
  await f.send('/結團'); await f.send('/開團 雞塊 100');
  assert.ok((await f.state()).customerAiDisabledAt); assert.equal(f.db.data.get(controlPath).mode, 'off');
});
