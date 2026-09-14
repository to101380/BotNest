const auth=require('C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
const project='planning-with-ai-52d58';
(async()=>{
 const account=auth.getGlobalDefaultAccount();
 const token=await auth.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
 async function call(resource,method='GET',body){
  const r=await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/${resource}`,{method,headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const data=await r.json();if(!r.ok)throw new Error(`${r.status} ${data.error?.status}: ${data.error?.message}`);return data;
 }
 const channels=await call('notificationChannels');
 let channel=channels.notificationChannels?.find(c=>c.type==='email'&&c.labels?.email_address==='to101380@gmail.com');
 if(!channel)channel=await call('notificationChannels','POST',{type:'email',displayName:'Identity security owner',labels:{email_address:'to101380@gmail.com'},enabled:true});
 console.log(JSON.stringify({notificationChannel:channel.name,verificationStatus:channel.verificationStatus}));
 let check;
 try {
 const checks=await call('uptimeCheckConfigs');
 check=checks.uptimeCheckConfigs?.find(c=>c.displayName==='Identity HTTPS availability');
 if(!check)check=await call('uptimeCheckConfigs','POST',{displayName:'Identity HTTPS availability',monitoredResource:{type:'uptime_url',labels:{project_id:project,host:`${project}.web.app`}},httpCheck:{path:'/',port:443,useSsl:true,validateSsl:true},period:'300s',timeout:'10s',selectedRegions:['USA','EUROPE','ASIA_PACIFIC']});
 console.log(JSON.stringify({uptimeCheck:check.name}));
 } catch(e) { console.log('Uptime unavailable: '+e.message); }
 const policies=await call('alertPolicies');
 const specs=[
  ...(check ? [{displayName:'Identity HTTPS outage',combiner:'OR',enabled:true,notificationChannels:[channel.name],conditions:[{displayName:'HTTPS unavailable for 5 minutes',conditionThreshold:{filter:`metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id="${check.name.split('/').pop()}"`,comparison:'COMPARISON_LT',thresholdValue:1,duration:'300s',aggregations:[{alignmentPeriod:'300s',perSeriesAligner:'ALIGN_FRACTION_TRUE'}],trigger:{count:2}}}],documentation:{mimeType:'text/markdown',content:'Check Firebase Hosting release and HTTPS availability. This detects site downtime, not OAuth sign-in failures.'},alertStrategy:{autoClose:'1800s'}}] : []),
  {displayName:'Identity security configuration changed',combiner:'OR',enabled:true,notificationChannels:[channel.name],conditions:[{displayName:'IAM, API key or authentication configuration modified',conditionMatchedLog:{filter:'log_id("cloudaudit.googleapis.com/activity") AND (protoPayload.serviceName="identitytoolkit.googleapis.com" OR protoPayload.serviceName="apikeys.googleapis.com" OR protoPayload.methodName:"SetIamPolicy" OR protoPayload.methodName:"setIamPolicy")'}}],alertStrategy:{notificationRateLimit:{period:'3600s'},autoClose:'1800s'},documentation:{mimeType:'text/markdown',content:'Review actor and change in Cloud Audit Logs. Expected maintenance can also trigger this alert. Never send tokens or application secrets in incident notes.'}},
 ];
 for(const spec of specs){if(!policies.alertPolicies?.some(p=>p.displayName===spec.displayName)){const p=await call('alertPolicies','POST',spec);console.log(JSON.stringify({alertPolicy:p.name,displayName:p.displayName}));}else console.log('Existing alert: '+spec.displayName);}
})().catch(e=>{console.error('Monitoring setup stopped: '+e.message);process.exitCode=1;});
