const auth=require('C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
(async()=>{
 const account=auth.getGlobalDefaultAccount();
 const token=await auth.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
 const url='https://identitytoolkit.googleapis.com/admin/v2/projects/planning-with-ai-52d58/config';
 async function call(method,query='',body){
  const r=await fetch(url+query,{method,headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const d=await r.json();if(!r.ok)throw new Error(`${r.status} ${d.error?.status}`);return d;
 }
 await call('PATCH','?updateMask=signIn.email.enabled,signIn.email.passwordRequired',{signIn:{email:{enabled:true,passwordRequired:true}}});
 console.log('Email/password enabled; passwordless email-link sign-in not enabled.');
 await call('PATCH','?updateMask=passwordPolicyConfig',{passwordPolicyConfig:{passwordPolicyEnforcementState:'ENFORCE',forceUpgradeOnSignin:false,passwordPolicyVersions:[{customStrengthOptions:{minPasswordLength:12,maxPasswordLength:128}}]}});
 console.log('Server password policy: 12–128 characters.');
 await call('PATCH','?updateMask=emailPrivacyConfig',{emailPrivacyConfig:{enableImprovedEmailPrivacy:true}});
 const current=await call('GET');
 console.log(JSON.stringify({emailEnabled:current.signIn?.email?.enabled,passwordRequired:current.signIn?.email?.passwordRequired,passwordPolicy:current.passwordPolicyConfig,emailPrivacy:current.emailPrivacyConfig}));
})().catch(e=>{console.error('Email configuration stopped: '+e.message);process.exitCode=1;});
