const fs = require('node:fs/promises');
const path = require('node:path');
const auth = require('C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
const root = path.resolve(__dirname, '..'), stage = path.join(root, '.deploy-group-buy');
(async () => {
  const account = auth.getGlobalDefaultAccount();
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  async function json(url) { const r = await fetch(url, { headers }); if (!r.ok) throw Error(`Metadata HTTP ${r.status}`); return r.json(); }
  await fs.mkdir(stage, { recursive: true });
  const project = 'planning-with-ai-52d58';
  const db = await json(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)`);
  console.log('Existing database:', db.name, db.databaseEdition || 'STANDARD', db.type);
  const fn = await json(`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/us-central1/functions/botnestApi`);
  const source = fn.buildConfig.source.storageSource;
  const zip = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(source.bucket)}/o/${encodeURIComponent(source.object)}?alt=media${source.generation ? `&generation=${source.generation}` : ''}`, { headers });
  if (!zip.ok) throw Error(`Source HTTP ${zip.status}`);
  await fs.writeFile(path.join(stage, 'live-source.zip'), Buffer.from(await zip.arrayBuffer()));
  const channel = await json(`https://firebasehosting.googleapis.com/v1beta1/sites/${project}/channels/live`);
  const version = channel.release.version;
  await fs.writeFile(path.join(stage, 'live-version.json'), JSON.stringify(version, null, 2));
  let next = '', files = [];
  do { const result = await json(`https://firebasehosting.googleapis.com/v1beta1/${version.name}/files?pageSize=1000${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`); files.push(...result.files); next = result.nextPageToken; } while (next);
  await fs.mkdir(path.join(stage, 'public'), { recursive: true });
  for (const file of files) {
    const relative = file.path.replace(/^\//, '');
    const dest = path.resolve(stage, 'public', relative);
    if (!dest.startsWith(path.resolve(stage, 'public') + path.sep)) throw Error('Invalid Hosting path');
    const r = await fetch(`https://${project}.web.app/${relative}`);
    if (!r.ok) throw Error(`Hosting file HTTP ${r.status}: ${relative}`);
    await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
  }
  const config = JSON.parse(await fs.readFile(path.join(root, 'firebase.json'), 'utf8'));
  delete config.firestore;
  const live = version.config || {};
  config.hosting = { ...live, site: project, public: 'public', ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
    rewrites: (live.rewrites || config.hosting.rewrites).map(item => typeof item.function === 'string' ? { source: item.glob || item.source, function: { functionId: item.function, region: item.functionRegion || 'us-central1' } } : item),
    headers: (live.headers || config.hosting.headers).map(item => ({ source: item.glob || item.source, headers: Array.isArray(item.headers) ? item.headers : Object.entries(item.headers).map(([key, value]) => ({ key, value })) })),
  };
  await fs.writeFile(path.join(stage, 'firebase.json'), JSON.stringify(config, null, 2));
  await fs.copyFile(path.join(root, 'public', 'line-inbox.js'), path.join(stage, 'public', 'line-inbox.js'));
  console.log('Fresh production snapshot downloaded:', files.length, 'Hosting files, Functions source.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
