const ORIGINS = new Set(['https://planning-with-ai-52d58.web.app', 'https://planning-with-ai-52d58.firebaseapp.com']);
const fail = (status, message) => Object.assign(new Error(message), { status });
// Runs before route dispatch, including handlers that bypass core.js.
export function validateRequestEnvelope(req) {
  const rawUrl = req.originalUrl || req.url || '/';
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192) throw fail(414, '請求網址過長。');
  const path = new URL(rawUrl, 'https://botnest.invalid').pathname;
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(req.method)) throw fail(405, '不支援此操作。');
  const limit = path.startsWith('/line-webhook/') || path === '/zernio-webhook' ? 1024 * 1024
    : path === '/api/ai/profile' ? 190000
    : /^\/api\/(?:login-security\/|ai\/(?:retention(?:\/|$)|workflow$|admin\/))/.test(path) ? 16384
    : 8 * 1024 * 1024;
  const length = req.get('content-length');
  if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw fail(400, '請求長度無效。');
  if (Number(length || 0) > limit || (req.rawBody?.length || 0) > limit) throw fail(413, '請求內容過大。');
  if ((req.get('authorization') || '').length > 16384) throw fail(400, '登入資訊格式錯誤。');
  const signedMedia = /^\/api\/(?:line|zernio)\/media\//.test(path);
  if (path.startsWith('/api/') && !signedMedia) {
    const origin = req.get('origin');
    if (origin && !ORIGINS.has(origin) || req.get('sec-fetch-site') === 'cross-site') throw fail(403, '請從正式網站操作。');
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      if (!ORIGINS.has(origin)) throw fail(403, '請從正式網站操作。');
      if (!/^application\/json(?:\s*;|$)/i.test(req.get('content-type') || '')) throw fail(415, '請使用 JSON 格式。');
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw fail(400, '請求格式錯誤。');
    }
  }
  return path;
}

export function secureResponse(res) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'private, no-store');
}
