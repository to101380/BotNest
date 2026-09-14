import test from "node:test";
import assert from "node:assert/strict";
import { hasFirebaseConfig, authErrorMessage, linkProviderAccount, reauthenticateForLink, validateEmailRegistration, reauthenticatePasswordForLink, providerName, linkEmailPassword } from "../public/auth-helpers.js";
const freshProof = () => ({uid:'original', target:'facebook.com', at:Date.now(), used:false});
test('registration only accepts email and matching long passwords, preserving whitespace',()=>{
 assert.ok(validateEmailRegistration('username','long-password','long-password'));
 assert.ok(validateEmailRegistration('u@example.com','short','short'));
 assert.ok(validateEmailRegistration('u@example.com','long-password','other-password'));
 assert.equal(validateEmailRegistration(' u@example.com ','  long password  ','  long password  '),null);
 assert.equal(providerName('password'),'Email／密碼');
});
test('password reauthentication refuses unverified email and proves the existing UID',async()=>{
 const user={uid:'original',email:'u@example.com',emailVerified:true,providerData:[{providerId:'password'}]};
 const sdk={EmailAuthProvider:{credential:(email,password)=>({email,password})},async reauthenticateWithCredential(u,c){assert.equal(u,user);assert.equal(c.email,user.email);assert.equal(c.password,'test-password');return {user};}};
 await assert.rejects(reauthenticatePasswordForLink({currentUser:{...user,emailVerified:false}},sdk,'test-password','google.com'),{code:'auth/email-not-verified'});
 const proof=await reauthenticatePasswordForLink({currentUser:user},sdk,'test-password','google.com');
 assert.equal(proof.uid,'original');assert.equal(proof.target,'google.com');
});
test('email login failures use a generic message',()=>{
 assert.equal(authErrorMessage({code:'auth/wrong-password'}),authErrorMessage({code:'auth/user-not-found'}));
 assert.equal(authErrorMessage({code:'auth/invalid-credential'}),authErrorMessage({code:'auth/user-not-found'}));
});
test("empty project configuration must not enable live login", () => {
  for (const config of [null, {}, { apiKey: "key", authDomain: "domain", projectId: "project", appId: " " }]) assert.equal(hasFirebaseConfig(config), false);
  assert.equal(hasFirebaseConfig({ apiKey: "key", authDomain: "domain", projectId: "project", appId: "app" }), true);
});
test("link requires an authenticated account and rejects already linked providers", async () => {
  const provider = { providerId: "facebook.com" };
  const sdk = { linkWithPopup() { assert.fail("Must not request linking"); } };
  await assert.rejects(linkProviderAccount({ currentUser: null }, sdk, provider), { code: "auth/requires-recent-login" });
  await assert.rejects(linkProviderAccount({ currentUser: { uid: "a", providerData: [provider] } }, sdk, provider), { code: "auth/provider-already-linked" });
});
test("link targets existing user, preserves UID and propagates credential conflicts", async () => {
  const user = { uid: "original", providerData: [{ providerId: "google.com" }] };
  const auth = { currentUser: user };
  const provider = { providerId: "facebook.com" };
  const sdk = { async linkWithPopup(target, value) {
    assert.equal(target, user); assert.equal(value, provider);
    return { user: { ...user, providerData: [...user.providerData, provider] } };
  } };
  assert.equal((await linkProviderAccount(auth, sdk, provider, freshProof())).uid, "original");
  const conflict = Object.assign(new Error("conflict"), { code: "auth/credential-already-in-use" });
  await assert.rejects(linkProviderAccount(auth, { async linkWithPopup() { throw conflict; } }, provider, freshProof()), { code: conflict.code });
  assert.equal(auth.currentUser, user);
});
test('link denies missing, stale, reused or mismatched reauthentication', async()=>{
 const auth={currentUser:{uid:'original',providerData:[{providerId:'google.com'}]}};
 const sdk={linkWithPopup(){assert.fail('Must not link');}};
 for(const proof of [undefined,{...freshProof(),at:Date.now()-61000},{...freshProof(),used:true},{...freshProof(),uid:'other'},{...freshProof(),target:'google.com'}]){
  await assert.rejects(linkProviderAccount(auth,sdk,{providerId:'facebook.com'},proof),{code:'auth/requires-recent-login'});
 }
});
test('reauthentication must prove the existing account and cannot switch users',async()=>{
 const user={uid:'original',providerData:[{providerId:'google.com'}]};
 const auth={currentUser:user};
 const sdk={async reauthenticateWithPopup(target,p){assert.equal(target,user);assert.equal(p.providerId,'google.com');return {user};}};
 const proof=await reauthenticateForLink(auth,sdk,{providerId:'google.com'},'facebook.com');
 assert.equal(proof.uid,user.uid);
 await assert.rejects(reauthenticateForLink(auth,sdk,{providerId:'facebook.com'},'google.com'));
 await assert.rejects(reauthenticateForLink(auth,{async reauthenticateWithPopup(){return {user:{uid:'attacker'}};}},{providerId:'google.com'},'facebook.com'));
});
test("provider collisions explain recovery; unknown exceptions never leak raw details", () => {
  assert.match(authErrorMessage({ code: "auth/account-exists-with-different-credential" }), /原本/);
  assert.ok(!authErrorMessage({ message: "PRIVATE_TOKEN" }).includes("PRIVATE_TOKEN"));
});

const passwordUser = () => ({uid:'original',email:'u@example.com',emailVerified:true,providerData:[{providerId:'google.com'}]});
const passwordProof = () => ({uid:'original',email:'u@example.com',target:'password',at:Date.now(),used:false});
test('password linking refuses unverified, changed, expired or already linked accounts before SDK calls', async()=>{
 const user=passwordUser();
 const cases=[
  [{...user,emailVerified:false},passwordProof()],
  [{...user,email:'other@example.com'},passwordProof()],
  [{...user,uid:'other'},passwordProof()],
  [user,{...passwordProof(),at:Date.now()-61000}],
  [user,{...passwordProof(),used:true}],
  [user,undefined],
  [{...user,providerData:[{providerId:'password'}]},passwordProof()]
 ];
 for(const [currentUser,proof] of cases) await assert.rejects(linkEmailPassword({currentUser},{},'long-password','long-password',proof));
});
test('password linking keeps the original UID, uses its email and consumes proof once', async()=>{
 const user=passwordUser(),auth={currentUser:user},proof=passwordProof();
 const sdk={validatePassword:async()=>({isValid:true}),EmailAuthProvider:{credential:(email,password)=>({email,password})},linkWithCredential:async(target,c)=>{
  assert.equal(target,user);assert.equal(c.email,user.email);assert.equal(c.password,'long-password');return {user};
 }};
 assert.equal((await linkEmailPassword(auth,sdk,'long-password','long-password',proof)).uid,'original');
 await assert.rejects(linkEmailPassword(auth,sdk,'long-password','long-password',proof));
});
test('password linking aborts session changes during validation and propagates conflicts without merging',async()=>{
 const user=passwordUser(),auth={currentUser:user};
 await assert.rejects(linkEmailPassword(auth,{validatePassword:async()=>{auth.currentUser={...user,uid:'other'};return {isValid:true};}},'long-password','long-password',passwordProof()),{code:'auth/requires-recent-login'});
 auth.currentUser=user;
 const sdk={validatePassword:async()=>({isValid:true}),EmailAuthProvider:{credential:()=>({})},linkWithCredential:async()=>{throw {code:'auth/credential-already-in-use'};}};
 await assert.rejects(linkEmailPassword(auth,sdk,'long-password','long-password',passwordProof()),{code:'auth/credential-already-in-use'});
 assert.equal(auth.currentUser,user);
});
