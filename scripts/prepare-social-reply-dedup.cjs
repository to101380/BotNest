// Stage only the reply-claim fix on top of the deployed social worker source.
const fs = require('node:fs/promises');
const path = require('node:path');
const auth = require('C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
const root = path.resolve(__dirname, '..'), stage = path.join(root, '.deploy-social-reply-dedup');
(async () => {
  const account = auth.getGlobalDefaultAccount();
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const response = await fetch('https://cloudfunctions.googleapis.com/v2/projects/planning-with-ai-52d58/locations/us-central1/functions/facebookAiAutoReply', { headers });
  if (!response.ok) throw Error(`Worker metadata HTTP ${response.status}`);
  const source = (await response.json()).buildConfig.source.storageSource;
  const download = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(source.bucket)}/o/${encodeURIComponent(source.object)}?alt=media${source.generation ? `&generation=${source.generation}` : ''}`, { headers });
  if (!download.ok) throw Error(`Worker source HTTP ${download.status}`);
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'live-source.zip'), Buffer.from(await download.arrayBuffer()));
  const config = JSON.parse(await fs.readFile(path.join(root, 'firebase.json'), 'utf8'));
  delete config.hosting; delete config.firestore;
  await fs.writeFile(path.join(stage, 'firebase.json'), JSON.stringify(config, null, 2));
  console.log('Downloaded current social worker snapshot.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
