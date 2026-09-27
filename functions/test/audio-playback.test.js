import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { audioTicket, verifyAudioTicket, socialAudio } from '../audio-playback.js';
import { createHandler, seal, normalizeEvent } from '../core.js';
import { createStore } from '../store.js';
import { memoryDb } from './memory.js';
const key=randomBytes(32).toString('base64'),now=1000000;
const scope={uid:'alice',platform:'instagram',accountId:'account'};
test('audio tickets bind user, platform and connected account; reject tampering and expiration before downloading',async()=>{
 const ticket=audioTicket({...scope,url:'https://example.com/voice'},key,now);
 assert.equal(verifyAudioTicket(ticket,scope,key,now).url,'https://example.com/voice');
 for(const args of [[ticket,{...scope,uid:'bob'},key,now],[ticket,{...scope,platform:'facebook'},key,now],[ticket,{...scope,accountId:'other'},key,now],[ticket,scope,key,now+300000],[ticket+'x',scope,key,now],[ticket,scope,'other',now]]){
  assert.throws(()=>verifyAudioTicket(...args));let downloads=0;
  await assert.rejects(socialAudio(...args,async()=>{downloads++;}));assert.equal(downloads,0);
 }
});
async function fixture(){
 const store=createStore(memoryDb()),channelId='1234567890';await store.bind('alice',{channelId,ownerUid:'alice',accessToken:seal('test-token',key,`${channelId}:access-token`)});
 const event=normalizeEvent({type:'message',webhookEventId:'voice',timestamp:now,source:{type:'user',userId:'U'+'a'.repeat(32)},message:{type:'audio',id:'voice-1'}});await store.ingest(channelId,event);
 let downloads=0;const wav=Buffer.from('RIFF0000WAVEfmt fake audio');
 const handler=createHandler({store,getKey:()=>key,now:()=>now,authorizeSession:async()=>{},verifyToken:async uid=>({uid,firebase:{sign_in_provider:'google.com'}}),fetchLine:async(url,options)=>{downloads++;assert.match(url,/api-data.line.me/);assert.equal(options.redirect,'error');return new Response(wav)}});
 const request=async(token,path)=>{const res={code:200,set(){return this},status(code){this.code=code;return this},json(body){this.body=body;return this}};await handler({url:path,method:'GET',get:()=>token?`Bearer ${token}`:''},res);return res};
 return {store,event,request,downloads:()=>downloads,path:`/api/line/conversations/${event.conversationId}/messages/voice-1/audio`,wav};
}
test('LINE audio playback requires login and owner access, and rejects withdrawn voice messages',async()=>{
 const f=await fixture();assert.equal((await f.request('',f.path)).code,401);assert.equal((await f.request('bob',f.path)).code,404);assert.equal(f.downloads(),0);
 const r=await f.request('alice',f.path);assert.equal(r.code,200);assert.equal(r.body.mime,'audio/wav');assert.deepEqual(Buffer.from(r.body.data,'base64'),f.wav);
 await f.store.ingest('1234567890',{...f.event,eventId:'withdrawn',unsent:true,type:'unsend',text:'[訊息已收回]'});
 assert.equal((await f.request('alice',f.path)).code,404);assert.equal(f.downloads(),1);
});
for(const platform of ['facebook','instagram'])test(`${platform}: audio playback endpoint requires user-bound ticket`,async()=>{
 const store={aiAttempt:async()=>{},zernioAccount:async()=>({[platform]:{accountId:'account'}})};let downloads=0;
 const handler=createHandler({store,getKey:()=>key,now:()=>now,authorizeSession:async()=>{},verifyToken:async uid=>({uid,firebase:{sign_in_provider:'google.com'}}),fetchAudio:async()=>{downloads++;return{bytes:Buffer.from('fake'),type:'audio/ogg'}}});
 const ticket=audioTicket({...scope,platform,url:'https://example.com/voice'},key,now);
 for(const [uid,expected] of [['',401],['bob',400],['alice',200]]){
 const res={code:200,set(){return this},status(code){this.code=code;return this},json(body){this.body=body;return this}};
 await handler({url:`/api/zernio/audio?platform=${platform}`,method:'POST',body:{ticket},get:()=>uid?`Bearer ${uid}`:''},res);assert.equal(res.code,expected);
 }
 assert.equal(downloads,1);
});

test('social message lists issue playback tickets only for live audio belonging to the connected account',async()=>{
 const store={aiAttempt:async()=>{},zernioAccount:async()=>({instagram:{accountId:'account'}})};
 const messages=[{id:'voice',accountId:'account',conversationId:'thread',attachments:[{type:'audio',url:'https://example.com/voice'}]},{id:'deleted',accountId:'account',conversationId:'thread',isDeleted:true,attachments:[{type:'audio',url:'https://example.com/voice'}]},{id:'foreign',accountId:'other',conversationId:'thread',attachments:[{type:'audio',url:'https://example.com/voice'}]}];
 const handler=createHandler({store,getKey:()=>key,getZernioKey:()=> 'fake',now:()=>now,authorizeSession:async()=>{},verifyToken:async()=>({uid:'alice',firebase:{sign_in_provider:'google.com'}}),fetchZernio:async()=>Response.json({messages})});
 const res={code:200,set(){return this},status(code){this.code=code;return this},json(body){this.body=body;return this}};
 await handler({url:'/api/zernio/messages?platform=instagram&conversationId=thread',method:'GET',get:()=> 'Bearer alice'},res);
 assert.equal(res.code,200);assert.equal(res.body.items.length,2);assert.equal(verifyAudioTicket(res.body.items[0].audioTicket,scope,key,now).url,'https://example.com/voice');assert.equal(res.body.items[1].audioTicket,undefined);
});
