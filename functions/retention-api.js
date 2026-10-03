import { validateRetention } from './retention-policy.js';
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createRetentionHandler({ service, verifyToken, accountStore, authorizeSession = async () => {}, now = Date.now }) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff');
    try {
      const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1]; let user;
      try { if (token) user = await verifyToken(token); } catch {}
      if (!user?.uid) throw fail(401, '請先登入。');
      if (!['google.com', 'password'].includes(user.firebase?.sign_in_provider) || user.firebase.sign_in_provider === 'password' && !user.email_verified) throw fail(403, '請先驗證帳號。');
      await authorizeSession(req, user);
      if (await accountStore.isAccountDisabled(user.uid)) throw fail(403, '帳號已停用。');
      await accountStore.aiAttempt(user.uid, 'api', now(), 120);
      const url = new URL(req.originalUrl || req.url, 'https://botnest.invalid'), path = url.pathname;
      if (['/api/ai/retention/export', '/api/ai/retention/package', '/api/ai/retention/download'].includes(path)) throw fail(404, '找不到此功能。');
      if (req.method === 'GET' && path === '/api/ai/retention') return res.json(await service.summary(user.uid));
      if (!['POST', 'PUT'].includes(req.method)) throw fail(405, '不支援此操作。');
      if (!['https://planning-with-ai-52d58.web.app', 'https://planning-with-ai-52d58.firebaseapp.com'].includes(req.get('origin'))) throw fail(403, '請從正式網站操作。');
      await accountStore.aiAttempt(user.uid, 'retention', now(), 6);
      if (path === '/api/ai/retention' && req.method === 'PUT') {
        const previous = await service.ensurePolicy(user.uid), preview = (await service.previewRef(user.uid).get()).data();
        const value = validateRetention(req.body, previous, preview, now());
        await accountStore.retentionSave(user.uid, value, previous.revision);
        return res.json({ policy: value });
      }
      if (path === '/api/ai/retention/scan' && req.method === 'POST') return res.status(202).json({ id: await service.queue(user.uid, 'scan') });
      throw fail(404, '找不到此功能。');
    } catch (e) { return res.status(e.status || 503).json({ error: e.status ? e.message : '資料管理暫時無法使用，請稍後重試。' }); }
  };
}
