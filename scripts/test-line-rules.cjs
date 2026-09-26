// Read-only Rules API simulation. Does not deploy rules or write documents.
const auth = require('C:/Users/to101/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
const fs = require('node:fs/promises');
(async () => {
  const account = auth.getGlobalDefaultAccount();
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const source = { files: [{ name: 'firestore.rules', content: await fs.readFile('firestore.botnest.rules', 'utf8') }] };
  const testCases = [];
  const paths = ['botnest/state', 'botnest/state/accounts/alice', 'botnest/state/channels/1234567890', 'botnest/state/channels/1234567890/conversations/abc/messages/1', 'botnest/state/channels/1234567890/outbox/example', 'botnest/state/channels/1234567890/limits/send'];
  for (const document of paths) for (const method of ['get', 'list', 'create', 'update', 'delete']) for (const signedIn of [false, true]) {
    testCases.push({ expectation: 'DENY', request: { path: `/databases/(default)/documents/${document}`, method, auth: signedIn ? { uid: 'alice', token: {} } : null, time: '2026-09-14T00:00:00Z' } });
  }
  testCases.push({ expectation: 'DENY', request: { path: '/databases/(default)/documents/legacy/example', method: 'get', auth: { uid: 'alice', token: {} }, time: '2026-09-14T00:00:00Z' } });
  testCases.push({ expectation: 'DENY', request: { path: '/databases/(default)/documents/legacy/example', method: 'get', auth: { uid: 'alice', token: {} }, time: '2026-09-19T00:00:00Z' } });
  const response = await fetch('https://firebaserules.googleapis.com/v1/projects/planning-with-ai-52d58:test', {
    method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, testSuite: { testCases } }), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error?.message || 'rules simulation failed'}`);
  const failed = (result.testResults || []).filter(item => item.state !== 'SUCCESS');
  console.log(JSON.stringify({ cases: testCases.length, completed: result.testResults?.length, failed: failed.length, issues: result.issues || [], failures: failed }));
  if (failed.length || result.testResults?.length !== testCases.length || result.issues?.some(item => item.severity === 'ERROR')) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
