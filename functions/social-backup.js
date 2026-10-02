import { unseal } from './core.js';
export function createLineBackupReader(getKey, fetcher = fetch) {
  return async (channel, id) => {
    if (!channel?.accessToken || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const token = unseal(channel.accessToken, getKey(), `${channel.channelId}:access-token`);
    const response = await fetcher(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(id)}/content`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) return null;
    const chunks = []; let size = 0; for await (const chunk of response.body) { size += chunk.length; if (size > 10 * 1024 * 1024) return null; chunks.push(Buffer.from(chunk)); }
    const mime = response.headers.get('content-type') || '', ext = /png/.test(mime) ? 'png' : /jpeg/.test(mime) ? 'jpg' : /audio/.test(mime) ? 'm4a' : 'bin';
    return { bytes: Buffer.concat(chunks), ext };
  };
}
export function createSocialBackupReader(getKey, fetcher = fetch) {
  return async path => {
    if (!path.startsWith('/inbox/')) throw Error('Invalid social export path');
    const response = await fetcher(`https://zernio.com/api/v1${path}`, { headers: { Authorization: `Bearer ${getKey()}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Social export unavailable'); return response.json();
  };
}
export async function downloadSocialBackup(url, fetcher = fetch) {
  let target = new URL(url);
  for (let n = 0; n < 4; n++) {
    if (target.protocol !== 'https:' || target.port || target.username || target.password || !/(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com)$/.test(target.hostname)) return null;
    const response = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { target = new URL(response.headers.get('location'), target); continue; }
    if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) return null;
    const chunks = []; let size = 0; for await (const chunk of response.body) { size += chunk.length; if (size > 10 * 1024 * 1024) { await response.body.cancel().catch(() => {}); return null; } chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks);
  } return null;
}
