import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { audioFile, readAudioResponse, MAX_AUDIO_BYTES, transcribeAudio, audioAttachments } from "../audio-input.js";
import { createAiResponder, createZernioAiResponder } from "../ai-responder.js";
import { createStore } from "../store.js";
import { normalizeEvent, seal, createHandler } from "../core.js";
import { memoryDb } from "./memory.js";
import { normalizeAiSettings } from "../ai-policy.js";
const wav = Buffer.from('RIFF0000WAVEfmt synthetic-test-only');
const reply = () => Response.json({output:[{content:[{type:'output_text',text:JSON.stringify({action:'reply',text:'您好，請問需要什麼協助？',grounded:true,kind:'clarification',sourceIds:[],reason:'確認需求'})}]}]});
test('audio signatures and actual byte bounds reject unsupported or oversized content',async()=>{
 assert.equal(audioFile(wav).extension,'wav');assert.equal(audioFile(Buffer.from('0000ftypM4A rest')).extension,'mp4');assert.equal(audioFile(Buffer.from('ID3xxxxx')).extension,'mp3');assert.equal(audioFile(Buffer.from([0x1a,0x45,0xdf,0xa3])).extension,'webm');
 for(const b of [Buffer.alloc(0),Buffer.from('<html>fake.mp3'),Buffer.alloc(MAX_AUDIO_BYTES+1)])assert.throws(()=>audioFile(b));
 await assert.rejects(readAudioResponse(new Response(wav,{headers:{'content-length':String(MAX_AUDIO_BYTES+1)}})));
 await assert.rejects(readAudioResponse(new Response(Buffer.alloc(MAX_AUDIO_BYTES+1))));
 await assert.rejects(readAudioResponse(new Response(null,{status:404})));
});
test('transcription sends multipart bytes with automatic boundary and rejects empty, long or failed results',async()=>{
 let calls=0;
 const fetchOpenAi=async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(options.headers.Authorization,'Bearer test');assert.equal(options.headers['Content-Type'],undefined);assert.equal(options.body.get('model'),'gpt-4o-mini-transcribe');assert.equal(options.body.get('file').name,'voice.wav');assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()),wav);return Response.json({text:'  您好  '})};
 assert.equal(await transcribeAudio(audioFile(wav),{getOpenAiKey:()=> 'test',fetchOpenAi}),'您好');assert.equal(calls,1);
 for(const response of [Response.json({text:''}),Response.json({text:'x'.repeat(6001)}),Response.json({text:[]}),new Response(null,{status:500})])await assert.rejects(transcribeAudio(audioFile(wav),{getOpenAiKey:()=> 'test',fetchOpenAi:async()=>response}));
});
test('audio attachment normalization preserves a second recording so batch processing is rejected',()=>{
 assert.deepEqual(audioAttachments({attachments:[{type:'image',url:'x'},{type:'audio',url:'y'}]}),[{type:'audio',url:'y'}]);assert.equal(audioAttachments({attachments:Array.from({length:3},()=>({type:'audio',url:'x'}))}).length,2);
});
async function fixture(provider,scenario='normal'){
 const db=memoryDb(),store=createStore(db),at=1000000,key=randomBytes(32).toString('base64'),channelId='1234567890';let item,downloads=0,transcriptions=0,inferences=0,sends=0,modelInput;
 await store.saveAccountAiSettings('alice',normalizeAiSettings({enabled:scenario!=='disabled',businessInfo:'最新商家資訊：週一營業。'}),at);
 if(provider==='line'){
 await store.bind('alice',{channelId,ownerUid:'alice',accessToken:seal('fake-token',key,`${channelId}:access-token`)});
 const event=normalizeEvent({type:'message',webhookEventId:'voice',timestamp:at,source:{type:'user',userId:'U'+'a'.repeat(32)},message:{id:'voice-1',type:'audio'}});await store.ingest(channelId,event);item={channelId,conversationId:event.conversationId,messageId:event.messageId};
 }else{
 const profileId='a'.repeat(24),accountId='b'.repeat(24);await store.saveZernioProfile('alice',profileId,at);await store.bindZernioPlatform('alice',profileId,provider,{accountId,platform:provider},at);
 item={uid:'alice',...await store.ingestZernio('alice',{provider,eventId:'voice',accountId,remoteConversationId:'thread',remoteMessageId:'voice-1',type:'audio',text:'[語音]',attachments:Array.from({length:scenario==='multiple'?2:1},()=>({type:'audio',url:'https://example.com/voice.m4a'})),sentAt:at})};
 }
 if(['human','off'].includes(scenario))await store.setAiControl('alice',provider,item.conversationId,{mode:scenario,pausedUntil:0,reason:'test'},at,0);
 const transport=async(url,o={})=>{
 if(url.includes('api-data.line.me')){downloads++;assert.equal(o.redirect,'error');if(scenario==='expired')throw Error('expired');return new Response(wav)}
 if(o.method==='POST' && (/\/messages$/.test(url)||/\/message\/(push|reply)$/.test(url)))sends++;
 return Response.json({messages:[{id:'voice-1',message:'[語音]',direction:'incoming'}]});
 };
 const config={store,getKey:()=>key,getOpenAiKey:()=> 'test',getZernioKey:()=> 'test',now:()=>at,fetchLine:transport,fetchZernio:transport,
 fetchAudio:async()=>{downloads++;if(scenario==='expired')throw Error('expired');return audioFile(wav)},
 fetchOpenAi:async(url,o)=>{
 if(url.endsWith('/transcriptions')){
 transcriptions++;
 if(scenario==='takeover')await store.setAiControl('alice',provider,item.conversationId,{mode:'human',pausedUntil:0,reason:'真人接手'},at+1,0);
 if(scenario==='settings')await store.saveAccountAiSettings('alice',normalizeAiSettings({enabled:true,businessInfo:'週二營業'}),at+1);
 if(scenario==='empty')return Response.json({text:''});
 return Response.json({text:scenario==='handoff'?'我要退款，找真人客服':'請問怎麼選擇商品？'});
 }
 inferences++;modelInput=JSON.parse(o.body);return reply();
 }};
 return {store,item,responder:provider==='line'?createAiResponder(config):createZernioAiResponder(config),counts:()=>({downloads,transcriptions,inferences,sends}),input:()=>modelInput};
}
for(const provider of ['line','facebook','instagram']){
 test(`${provider}: voice becomes customer text with current knowledge, without duplicate replies or raw audio logs`,async()=>{
 const f=await fixture(provider);assert.deepEqual(await f.responder(f.item),{sent:true});await f.responder(f.item);assert.deepEqual(f.counts(),{downloads:1,transcriptions:1,inferences:1,sends:1});
 assert.match(f.input().input.at(-1).content,/語音辨識.*請問怎麼選擇商品/);assert.equal(f.input().input.at(-1).role,'user');assert.match(f.input().instructions,/最新商家資訊/);assert.ok(!JSON.stringify(await f.store.aiLogs('alice')).includes(wav.toString('base64')));
 });
 for(const scenario of ['human','off','disabled'])test(`${provider}: ${scenario} prevents audio downloads and paid inference`,async()=>{const f=await fixture(provider,scenario);await f.responder(f.item);assert.deepEqual(f.counts(),{downloads:0,transcriptions:0,inferences:0,sends:0})});
 test(`${provider}: spoken handoff keyword skips answer model and switches conversation to human`,async()=>{const f=await fixture(provider,'handoff');assert.deepEqual(await f.responder(f.item),{handoff:true});assert.equal(f.counts().inferences,0);assert.equal((await f.store.aiControl('alice',provider,f.item.conversationId)).mode,'human')});
 for(const scenario of ['expired','empty'])test(`${provider}: ${scenario} audio asks for clarification without guessing`,async()=>{const f=await fixture(provider,scenario);assert.deepEqual(await f.responder(f.item),{sent:true});assert.equal(f.counts().inferences,0);assert.equal(f.counts().sends,1)});
 for(const scenario of ['takeover','settings'])test(`${provider}: ${scenario} during transcription cancels delivery`,async()=>{const f=await fixture(provider,scenario);assert.deepEqual(await f.responder(f.item),{skipped:true});assert.equal(f.counts().sends,0)});
 if(provider!=='line')test(`${provider}: multiple recordings ask for one recording without silently ignoring content`,async()=>{const f=await fixture(provider,'multiple');await f.responder(f.item);assert.deepEqual(f.counts(),{downloads:0,transcriptions:0,inferences:0,sends:1})});
}
for(const provider of ['facebook','instagram'])test(`${provider}: authenticated audio webhooks keep URL, caption and message type`,async()=>{
 const key=randomBytes(32).toString('base64');let saved;
 const handler=createHandler({getKey:()=>key,now:()=>1000000,store:{zernioOwnerByAccount:async()=>({uid:'alice'}),ingestZernio:async(uid,event)=>{assert.equal(uid,'alice');saved=event;return{created:true}}}});
 for(const text of ['', '請聽這段']){
 const rawBody=Buffer.from(JSON.stringify({event:'message.received',data:{platform:provider,conversationId:'thread',account:{id:'account'},message:{id:'voice',text,attachments:[{type:'audio',url:'https://example.com/voice.m4a'}]}}}));
 const res={code:200,set(){return this},status(code){this.code=code;return this},json(){return this}};
 await handler({url:'/zernio-webhook',method:'POST',rawBody,get:()=>createHmac('sha256',Buffer.from(key,'base64')).update('botnest-zernio-webhook-v1').digest('hex')},res);
 assert.equal(res.code,200);assert.equal(saved.type,'audio');assert.equal(saved.text,text||'[語音]');assert.equal(saved.attachments[0].type,'audio');
 }
});

test('Messenger Ogg/Opus voice is submitted as an ogg audio file',async()=>{
 const bytes=Buffer.concat([Buffer.from('OggS'),Buffer.alloc(24),Buffer.from('OpusHead')]);
 const file=audioFile(bytes);assert.equal(file.extension,'ogg');assert.equal(file.type,'audio/ogg');
 assert.equal(await transcribeAudio(file,{getOpenAiKey:()=> 'test',fetchOpenAi:async(_,options)=>{assert.equal(options.body.get('file').name,'voice.ogg');assert.equal(options.body.get('file').type,'audio/ogg');return Response.json({text:'請問如何訂購？'})}}),'請問如何訂購？');
 assert.throws(()=>audioFile(Buffer.from('OggS')));
 const invalid=Buffer.from(bytes);invalid[4]=1;assert.throws(()=>audioFile(invalid));
});
test('Meta attachment requests include an application User-Agent and retain pinned DNS across redirects',async()=>{
 const { downloadPublicAudio }=await import('../audio-input.js');const {EventEmitter}=await import('node:events');const {Readable}=await import('node:stream');let calls=0;
 const validate=async value=>({url:new URL(value),address:{address:'93.184.216.34',family:4}});
 const request=(url,options,callback)=>{
 calls++;assert.equal(options.headers['User-Agent'],'BotNest/1.0');assert.equal(options.headers.Authorization,undefined);options.lookup(url.hostname,{},(_,address)=>assert.equal(address,'93.184.216.34'));
 const req=new EventEmitter();req.destroy=error=>req.emit('error',error);
 queueMicrotask(()=>{const first=calls===1;const res=Readable.from(first?[]:[Buffer.from('0000ftypisom0000')]);res.statusCode=first?302:200;res.headers=first?{location:'https://cdn.example.com/voice'}:{};res.on('end',()=>req.emit('close'));callback(res)});return req;
 };
 assert.equal((await downloadPublicAudio('https://lookaside.example.com/voice',{validate,request})).extension,'mp4');assert.equal(calls,2);
});
