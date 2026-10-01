import test from "node:test";
import assert from "node:assert/strict";
import { createProfileHandler, createProfileStore, validateProfile } from "../account-profile.js";
import { createStore } from "../store.js";
import { publicAdminUser } from "../admin-users.js";
import { memoryDb } from "./memory.js";
const avatar = Buffer.from([255,216,255,224,0,1,255,217]).toString("base64");
test("profile input rejects extra identity, empty names, SVG and oversized avatars", () => {
  for (const value of [{ name:"",revision:0 },{name:"x",revision:0,uid:"other"},{name:"x",revision:0,avatar:Buffer.from('<svg></svg>').toString('base64')},{name:"x",revision:0,avatar:Buffer.alloc(140000,1).toString('base64')},{name:'x'.repeat(81),revision:0}]) assert.throws(()=>validateProfile(value));
  assert.equal(validateProfile({name:" Alice ",revision:0,avatar}).name,"Alice");
});
test("profile persists privately, preserves avatar on name-only saves, and detects conflicts", async () => {
  const db=memoryDb(),store=createProfileStore(db);
  const first=await store.save("alice",validateProfile({name:"Alice",revision:0,avatar}),1);
  assert.equal(first.revision,1); assert.match(first.avatar,/^data:image\/jpeg;base64,/);
  const next=await store.save("alice",validateProfile({name:"New name",revision:1}),2);
  assert.equal(next.avatar,first.avatar); assert.equal((await store.read("alice")).name,"New name"); assert.equal((await store.read("bob")).name,null);
  assert.equal(publicAdminUser({uid:"alice"},{account:db.data.get("botnest/state/accounts/alice")}).name,"New name");
  await assert.rejects(store.save("alice",{name:"old",revision:0},3),{status:409});
  db.data.set("botnest/state/accounts/alice",{access:{disabled:true}});
  await assert.rejects(store.save("alice",{name:"denied",revision:2},4),{status:403});
});
test("profile API uses verified UID, blocks disabled users and limits writes",async()=>{
  const db=memoryDb(),store=createProfileStore(db),accountStore=createStore(db);
  let identity={uid:"alice",firebase:{sign_in_provider:"google.com"}};
  const handle=createProfileHandler({verifyToken:async()=>identity,store,accountStore,now:()=>1000});
  const call=async(method,body,origin="https://planning-with-ai-52d58.web.app")=>{let status=200,result;await handle({method,body,get:n=>n==='authorization'?'Bearer t':origin},{set(){},status(n){status=n;return this},json(v){result=v}});return{status,result};};
  assert.equal((await call('PUT',{name:'Alice',revision:0},'https://evil.test')).status,403);
  assert.equal((await call('PUT',{name:'Alice',revision:0})).status,200);
  assert.equal((await call('GET')).result.name,'Alice');
  for(let revision=1;revision<6;revision++)assert.equal((await call('PUT',{name:'Alice',revision})).status,200);
  assert.equal((await call('PUT',{name:'Alice',revision:6})).status,429);
  identity={uid:'bob',firebase:{sign_in_provider:'password'},email_verified:false};assert.equal((await call('GET')).status,403);
  identity=null;assert.equal((await call('GET')).status,401);
  identity={uid:'alice',firebase:{sign_in_provider:'google.com'}};db.data.set('botnest/state/accounts/alice',{access:{disabled:true}});assert.equal((await call('GET')).status,403);
});
