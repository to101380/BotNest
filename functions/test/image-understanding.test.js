import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { imageDataUrl, readImageResponse, MAX_IMAGE_BYTES, downloadPublicImage, imageAttachments } from "../image-input.js";
import { generateAnswer } from "../ai-engine.js";
import { createAiResponder, createZernioAiResponder } from "../ai-responder.js";
import { createStore } from "../store.js";
import { normalizeEvent, seal } from "../core.js";
import { memoryDb } from "./memory.js";
import { normalizeAiSettings } from "../ai-policy.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const answer = kind => Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({action:"reply",text:"圖片中的文字是測試。",reason:"辨識圖片",grounded:true,kind,sourceIds:[]}) }] }] });
test("image byte limits and signature validation reject HTML, empty and oversized responses", async () => {
 assert.match(imageDataUrl(png), /^data:image\/png;base64,/);
 for(const bytes of [Buffer.from('<html>'),Buffer.alloc(0),Buffer.alloc(MAX_IMAGE_BYTES+1)]) assert.throws(()=>imageDataUrl(bytes));
 await assert.rejects(readImageResponse(new Response(png,{headers:{'content-length':String(MAX_IMAGE_BYTES+1)}})));
 await assert.rejects(readImageResponse(new Response(Buffer.alloc(MAX_IMAGE_BYTES+1))));
 await assert.rejects(readImageResponse(new Response(null,{status:404})));
});
test("private URLs are rejected before any image HTTP request",async()=>{
 for(const url of ['http://example.com/a.png','https://127.0.0.1/a','https://[::1]/a','https://user:pass@example.com/a']) await assert.rejects(downloadPublicImage(url,{request:()=>{assert.fail('must not request')}}));
});
test("attachment normalization excludes other media and retains fourth image to enforce count limit",()=>{
 assert.deepEqual(imageAttachments({attachments:[{type:'video',url:'x'},{type:'image',url:'y'}]}),[{type:'image',url:'y'}]);
 assert.equal(imageAttachments({attachments:Array.from({length:8},()=>({type:'image',url:'x'}))}).length,4);
});
test("vision input stays separate from business evidence and does not mutate history",async()=>{
 const history=[{role:'user',content:'看這張圖片'}];let request;
 const result=await generateAnswer({settings:{},knowledge:[],history,images:async()=>[imageDataUrl(png)],getOpenAiKey:()=> 'test',fetchOpenAi:async(_,o)=>{request=JSON.parse(o.body);return answer('answer')}});
 assert.equal(request.input[0].content[1].type,'input_image');assert.equal(request.store,false);
 assert.equal(history[0].content,'看這張圖片');assert.equal(result.action,'handoff');
});
async function fixture(provider,mode='ai',failure=false){
 const store=createStore(memoryDb()),at=1000000,key=randomBytes(32).toString('base64'),channelId='1234567890';let item,downloads=0,inferences=0,sends=0;
 await store.saveAccountAiSettings('alice',normalizeAiSettings({enabled:true}),at);
 if(provider==='line'){
 await store.bind('alice',{channelId,ownerUid:'alice',accessToken:seal('fake-token',key,`${channelId}:access-token`)});
 const event=normalizeEvent({type:'message',webhookEventId:'image',timestamp:at,source:{type:'user',userId:'U'+'a'.repeat(32)},message:{id:'image-1',type:'image'}});
 await store.ingest(channelId,event);item={channelId,conversationId:event.conversationId,messageId:event.messageId};
 }else{
 const profileId='a'.repeat(24),accountId='b'.repeat(24);await store.saveZernioProfile('alice',profileId,at);await store.bindZernioPlatform('alice',profileId,provider,{accountId,platform:provider},at);
 item={uid:'alice',...await store.ingestZernio('alice',{provider,eventId:'image',accountId,remoteConversationId:'thread',remoteMessageId:'image-1',type:'image',text:'[圖片]',attachments:[{type:'image',url:'https://example.com/image.png'}],sentAt:at})};
 }
 if(mode!=='ai')await store.setAiControl('alice',provider,item.conversationId,{mode,pausedUntil:0,reason:'test'},at,0);
 const transport=async(url,o={})=>{
 if(url.includes('api-data.line.me')){downloads++;assert.equal(o.redirect,'error');if(failure)throw Error('expired');return new Response(png)}
 if(o.method==='POST' && (/\/messages$/.test(url)||/\/message\/(push|reply)$/.test(url)))sends++;
 return Response.json({messages:[]});
 };
 const config={store,getKey:()=>key,getOpenAiKey:()=> 'test',getZernioKey:()=> 'test',now:()=>at,fetchLine:transport,fetchZernio:transport,
 fetchImage:async()=>{downloads++;if(failure)throw Error('expired');return imageDataUrl(png)},
 fetchOpenAi:async(_,o)=>{inferences++;assert.equal(JSON.parse(o.body).input.at(-1).content[1].type,'input_image');return answer('casual')}};
 return {store,item,responder:provider==='line'?createAiResponder(config):createZernioAiResponder(config),counts:()=>({downloads,inferences,sends})};
}
for(const provider of ['line','facebook','instagram']){
 test(`${provider}: incoming image is read once, replied once, and bytes never enter logs`,async()=>{
 const f=await fixture(provider);assert.deepEqual(await f.responder(f.item),{sent:true});await f.responder(f.item);
 assert.deepEqual(f.counts(),{downloads:1,inferences:1,sends:1});assert.ok(!JSON.stringify(await f.store.aiLogs('alice')).includes('base64'));
 });
 for(const mode of ['human','off'])test(`${provider}: ${mode} prevents image download and inference`,async()=>{const f=await fixture(provider,mode);await f.responder(f.item);assert.deepEqual(f.counts(),{downloads:0,inferences:0,sends:0})});
 test(`${provider}: unavailable image requests clarification without model inference`,async()=>{const f=await fixture(provider,'ai',true);assert.deepEqual(await f.responder(f.item),{sent:true});assert.deepEqual(f.counts(),{downloads:1,inferences:0,sends:1})});
}

test("public downloader pins DNS and checks redirect destinations before following", async () => {
 const { EventEmitter } = await import('node:events');const { Readable } = await import('node:stream');let requests=0,lookups=[];
 const validate=async value=>{if(value.includes('127.0.0.1'))throw Error('private');return {url:new URL(value),address:{address:'93.184.216.34',family:4}}};
 const request=(url,options,callback)=>{
 requests++;options.lookup(url.hostname,{},(_,address)=>lookups.push(address));assert.equal(options.headers.Authorization,undefined);
 const req=new EventEmitter();req.destroy=error=>req.emit('error',error);
 queueMicrotask(()=>{const response=Readable.from([]);response.statusCode=302;response.headers={location:'https://127.0.0.1/private'};callback(response);req.emit('close')});return req;
 };
 await assert.rejects(downloadPublicImage('https://example.com/image',{validate,request}));assert.equal(requests,1);assert.deepEqual(lookups,['93.184.216.34']);
});
test("public downloader validates actual bytes even when content length is absent",async()=>{
 const { EventEmitter } = await import('node:events');const { Readable } = await import('node:stream');
 const validate=async value=>({url:new URL(value),address:{address:'93.184.216.34',family:4}});
 const request=(_,options,callback)=>{const req=new EventEmitter();req.destroy=error=>req.emit('error',error);queueMicrotask(()=>{const res=Readable.from([png]);res.statusCode=200;res.headers={};res.on('end',()=>req.emit('close'));callback(res)});return req};
 assert.equal(await downloadPublicImage('https://example.com/image',{validate,request}),imageDataUrl(png));
});

for (const provider of ['facebook', 'instagram']) test(`${provider}: authenticated webhook retains image attachments and captions, and rejects unsigned payloads`, async () => {
 const { createHandler } = await import('../core.js');const { createHmac } = await import('node:crypto');
 const key=randomBytes(32).toString('base64');let saved;
 const handler=createHandler({getKey:()=>key,now:()=>1000000,store:{zernioOwnerByAccount:async()=>({uid:'alice'}),ingestZernio:async(uid,event)=>{assert.equal(uid,'alice');saved=event;return {created:true}}}});
 const invoke=async(signed,text)=>{
 const rawBody=Buffer.from(JSON.stringify({event:'message.received',data:{platform:provider,conversationId:'thread',account:{id:'account'},message:{id:'image',text,attachments:[{type:'image',url:'https://example.com/photo.png'}]}}}));
 const res={code:200,set(){return this},status(code){this.code=code;return this},json(body){this.body=body;return this}};
 await handler({url:'/zernio-webhook',method:'POST',rawBody,get:()=>signed?createHmac('sha256',Buffer.from(key,'base64')).update('botnest-zernio-webhook-v1').digest('hex'):''},res);return res;
 };
 assert.equal((await invoke(false,'')).code,401);assert.equal(saved,undefined);
 assert.equal((await invoke(true,'')).code,200);assert.equal(saved.type,'image');assert.equal(saved.text,'[圖片]');assert.equal(saved.attachments.length,1);
 await invoke(true,'請幫我看文字');assert.equal(saved.text,'請幫我看文字');assert.equal(saved.type,'image');
});
