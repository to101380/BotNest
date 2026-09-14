// Run only for the explicitly authorized project. No secrets are logged/backed up.
const auth = require('C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
const fs = require('node:fs/promises');
const project = 'planning-with-ai-52d58';
(async()=>{
 const account=auth.getGlobalDefaultAccount();
 const token=await auth.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
 async function call(url,method='GET',body){
  const r=await fetch(url,{method,headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const data=await r.json(); if(!r.ok) throw new Error(`${r.status} ${data.error?.status||'REQUEST_FAILED'}`);return data;
 }
 const base=`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;
 const config=await call(base);
 const keys=await call('https://apikeys.googleapis.com/v2/projects/522522721239/locations/global/keys');
 const key=keys.keys.find(k=>k.name.endsWith('/f96ff513-df25-4900-bb6e-9b9e8e608065'));
 if(!key)throw new Error('Expected web key missing');
 await fs.mkdir('security',{recursive:true});
 const backup={authorizedDomains:config.authorizedDomains,anonymousEnabled:config.signIn?.anonymous?.enabled,key:{name:key.name,restrictions:key.restrictions}};
 await fs.writeFile('security/cloud-before.json',JSON.stringify(backup,null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 await call(`${base}?updateMask=signIn.anonymous.enabled,authorizedDomains`,'PATCH',{
  signIn:{anonymous:{enabled:false}},authorizedDomains:[`${project}.firebaseapp.com`,`${project}.web.app`]
 });
 console.log('Anonymous sign-in disabled; OAuth domains restricted to the two production domains.');
 const operation=await call(`https://apikeys.googleapis.com/v2/${key.name}?updateMask=restrictions`,'PATCH',{
  name:key.name,etag:key.etag,restrictions:{browserKeyRestrictions:{allowedReferrers:[`https://${project}.web.app/*`,`https://${project}.firebaseapp.com/*`]},apiTargets:[{service:'identitytoolkit.googleapis.com'},{service:'securetoken.googleapis.com'}]}
 });
 if(operation.name){
  let state=operation;
  for(let i=0;i<20&&!state.done;i++){await new Promise(r=>setTimeout(r,1000));state=await call(`https://apikeys.googleapis.com/v2/${operation.name}`);}
  if(!state.done||state.error)throw new Error('Key restriction operation did not complete successfully');
 }
 console.log('Web key restricted to Authentication/Token APIs and production origins.');
 try{await call(`${base}?updateMask=monitoring.requestLogging.enabled`,'PATCH',{monitoring:{requestLogging:{enabled:true}}});console.log('Auth request logging enabled.');}
 catch(e){console.log('Auth request logging unavailable: '+e.message);}
 const db=await call(`https://firestore.googleapis.com/v1/projects/${project}/databases`);
 console.log(JSON.stringify({databases:db.databases?.map(d=>({name:d.name,type:d.type,databaseEdition:d.databaseEdition}))}));
})().catch(e=>{console.error('Hardening stopped: '+e.message);process.exitCode=1;});
