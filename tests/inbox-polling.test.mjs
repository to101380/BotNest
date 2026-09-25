import test from 'node:test';
import assert from 'node:assert/strict';
import { pollDelay, needsMessageRefresh, conversationVersion } from '../public/inbox-polling.js';
test('idle polling halves steady-state requests while changes restore the 10 second interval', () => {
 assert.deepEqual([0,1,2,3,4,100].map(n=>pollDelay(n,false)),[10000,20000,40000,80000,120000,120000]);
 assert.deepEqual([0,1,2,3,100].map(n=>pollDelay(n,true)),[10000,20000,40000,60000,60000]);
});
test('unchanged message windows are reused but reconciled every minute', () => {
 const item={id:'line-a',updatedAt:100,lastText:'hello'};
 const previous={id:item.id,version:conversationVersion(item),at:1000};
 assert.equal(needsMessageRefresh(previous,item,11000),false);
 assert.equal(needsMessageRefresh(previous,item,61000),true);
 assert.equal(needsMessageRefresh(previous,item,11000,true),true);
 assert.equal(needsMessageRefresh(previous,{...item,updatedAt:101},11000),true);
 assert.equal(needsMessageRefresh(previous,{...item,lastText:'new'},11000),true);
 assert.equal(needsMessageRefresh(previous,{...item,id:'instagram-b'},11000),true);
 assert.equal(needsMessageRefresh(null,item,11000),true);
 assert.equal(needsMessageRefresh(previous,null,11000),false);
});
