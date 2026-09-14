// Read-only audit. Uses the existing Firebase CLI login; never prints tokens or secrets.
const auth = require('C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
const project = 'planning-with-ai-52d58';
(async () => {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI login required');
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  async function get(url, options = {}) {
    const r = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
    const data = await r.json();
    return r.ok ? data : { httpStatus: r.status, errorCode: data.error?.status };
  }
  const results = await Promise.allSettled([
    get(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`).then(x => ({area:'auth',httpStatus:x.httpStatus,authorizedDomains:x.authorizedDomains,anonymousEnabled:x.signIn?.anonymous?.enabled,emailEnabled:x.signIn?.email?.enabled,phoneEnabled:x.signIn?.phoneNumber?.enabled,monitoring:x.monitoring,subtype:x.subtype})),
    get(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/defaultSupportedIdpConfigs`).then(x => ({area:'providers',httpStatus:x.httpStatus,providers:x.defaultSupportedIdpConfigs?.map(p=>({name:p.name,enabled:p.enabled}))})),
    get(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`, {method:'POST',body:'{}'}).then(x=>({area:'iam',httpStatus:x.httpStatus,bindings:x.bindings?.map(b=>({role:b.role,members:b.members}))})),
    get(`https://apikeys.googleapis.com/v2/projects/522522721239/locations/global/keys`).then(x=>({area:'keys',httpStatus:x.httpStatus,keys:x.keys?.map(k=>({name:k.name,displayName:k.displayName,restrictions:k.restrictions,etag:k.etag}))})),
    get(`https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`).then(x=>({area:'billing',httpStatus:x.httpStatus,billingEnabled:x.billingEnabled})),
    get(`https://firebaserules.googleapis.com/v1/projects/${project}/releases`).then(async x=>({area:'rules',httpStatus:x.httpStatus,releases:await Promise.all((x.releases||[]).map(async release=>({name:release.name,source:(await get(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`)).source})))})),
    get(`https://firebase.googleapis.com/v1beta1/projects/${project}/webApps`).then(x=>({area:'apps',httpStatus:x.httpStatus,apps:x.apps?.map(a=>({displayName:a.displayName,appId:a.appId}))})),
  ]);
  for (const result of results) console.log(JSON.stringify(result.status === 'fulfilled' ? result.value : {error:'Audit request failed'}));
})().catch(()=>{console.error('Cloud audit could not authenticate or finish.');process.exitCode=1;});
