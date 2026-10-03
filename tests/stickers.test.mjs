import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../functions/core.js';
import { socialAttachment } from '../functions/stickers.js';
import { lineStickerUrl } from '../public/stickers.js';
import { createStore } from '../functions/store.js';
import { memoryDb } from '../functions/test/memory.js';
import { initialPolicy, DAY } from '../functions/retention-policy.js';
test('LINE sticker IDs survive ingestion, render via fixed CDN, and disappear on unsend', async () => {
  const event = { type:'message', webhookEventId:'event', timestamp:Date.now(), source:{type:'user',userId:'U'+'a'.repeat(32)}, message:{id:'sticker1',type:'sticker',stickerId:'52002734',packageId:'11537',stickerResourceType:'STATIC',keywords:['謝謝'],text:'感謝',replyToken:'secret'} };
  const normalized=normalizeEvent(event), db=memoryDb(), store=createStore(db);
  await store.ingest('channel',normalized);
  const m=await store.getMessage('channel',normalized.conversationId,'sticker1');
  assert.equal(m.sticker.stickerId,'52002734');assert.equal(m.sticker.replyToken,undefined);assert.equal(lineStickerUrl(m.sticker),'https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker.png');
  await store.ingest('channel',{...normalized,eventId:'unsend',unsent:true});
  assert.equal((await store.getMessage('channel',normalized.conversationId,'sticker1')).sticker,undefined);
});
test('invalid and arranged stickers do not become arbitrary remote URLs',()=>{
  assert.equal(lineStickerUrl({stickerId:'../x',packageId:'1'}),null);
  assert.equal(lineStickerUrl({stickerId:'651698630',packageId:'30563'}),null);
});
test('IG sticker attachments render as images with bounded URLs and metadata',()=>{
  const at=Date.now(), image=socialAttachment({type:'sticker',payload:{url:'https://scontent.cdninstagram.com/demo.png'}},at-2*DAY,at);
  assert.equal(image.kind,'image');assert.equal(image.name,'貼圖');assert.ok(image.expiresAt>at);
  assert.equal(socialAttachment({type:'sticker'},at,at),null);
  assert.equal(socialAttachment({type:'file',url:'https://x/doc'},at,at).kind,'file');
});
test('sticker media follows the existing 90 day attachment policy',async()=>{
  const db=memoryDb(),store=createStore(db),at=Date.now();
  await db.collection('botnest').doc('state').collection('accounts').doc('alice').collection('retention').doc('settings').set({...initialPolicy(at-200*DAY),enabled:true});
  const [old,recent]=await store.retainedMessages('alice','conv',[{id:'old',type:'sticker',sentAt:at-91*DAY,sticker:{stickerId:'1',packageId:'1'}},{id:'new',type:'sticker',sentAt:at-DAY}],at);
  assert.equal(old.attachmentExpired,true);assert.equal(recent.attachmentExpired,undefined);
});
