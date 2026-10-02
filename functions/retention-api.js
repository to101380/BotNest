import { createHash } from "node:crypto";
import { validateRetention } from './retention-policy.js';
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createRetentionHandler({ service, bucket, verifyToken, accountStore, authorizeSession = async () => {}, now = Date.now }) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff');
    try {
      const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1]; let user;
      try { if (token) user = await verifyToken(token); } catch {}
      if (!user?.uid) throw fail(401, '請先登入。');
      if (!['google.com', 'password'].includes(user.firebase?.sign_in_provider) || user.firebase.sign_in_provider === 'password' && !user.email_verified) throw fail(403, '請先驗證帳號。');
      await authorizeSession(req, user);
      if (await accountStore.isAccountDisabled(user.uid)) throw fail(403, '帳號已停用。');
      const url = new URL(req.originalUrl || req.url, 'https://botnest.invalid'), path = url.pathname;
      if (req.method === 'GET' && path === '/api/ai/retention') return res.json(await service.summary(user.uid));
      if (req.method === 'GET' && path === '/api/ai/retention/download') {
        const id = url.searchParams.get('id'), part = Number(url.searchParams.get('part'));
        if (!/^[a-f0-9-]{36}$/.test(id || '') || !Number.isSafeInteger(part) || part < 1) throw fail(400, '下載參數錯誤。');
        const job = (await service.jobs(user.uid).doc(id).get()).data();
        if (!job || job.type !== 'export' || job.status !== 'ready' || job.expiresAt <= now() || part > job.parts) throw fail(404, '備份尚未完成或已到期。');
        const filename = `part-${String(part).padStart(6, '0')}.zip`, [bytes] = await bucket.file(service.objectPrefix(user.uid, id) + filename).download();
        res.set('Content-Type', 'application/zip'); res.set('Content-Disposition', `attachment; filename="BotNest-${id}-${filename}"`); return res.send(bytes);
      }
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
      if (path === '/api/ai/retention/export' && req.method === 'POST') {
        if (Object.keys(req.body || {}).some(key => !['conversationId', 'remoteId'].includes(key))) throw fail(400, '匯出參數錯誤。');
        const id = req.body?.conversationId || null;
        if (id && (typeof id !== 'string' || !/^(?:(?:facebook|instagram)-)?[a-f0-9]{64}$/.test(id))) throw fail(400, '對話參數錯誤。');
        if (id) {
          const ctx = await service.context(user.uid), social = /^(facebook|instagram)-(.+)$/.exec(id);
          const ref = social ? ctx.account.collection('zernioConversations').doc(social[2]) : ctx.channel?.collection('conversations').doc(id);
          if (social && req.body.remoteId) {
            const remoteId = req.body.remoteId, connected = ctx.accountData.zernio?.[social[1]];
            if (typeof remoteId !== 'string' || remoteId.length > 512 || /[\u0000-\u001f]/.test(remoteId) || !connected?.accountId || createHash('sha256').update(`${connected.accountId}:${remoteId}`).digest('hex') !== social[2]) throw fail(400, '對話參數錯誤。');
          } else if (!ref || !(await ref.get()).exists) throw fail(404, '找不到這段已儲存的對話。');
        }
        return res.status(202).json({ id: await service.queue(user.uid, 'export', id, req.body?.remoteId || null) });
      }
      throw fail(404, '找不到此功能。');
    } catch (e) { return res.status(e.status || 503).json({ error: e.status ? e.message : '資料管理暫時無法使用，請稍後重試。' }); }
  };
}
