import { deflateRawSync } from 'node:zlib';
import { escapeHtml } from './retention-policy.js';
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(bytes) { let n = 0xffffffff; for (const byte of bytes) n = table[(n ^ byte) & 255] ^ n >>> 8; return (n ^ 0xffffffff) >>> 0; }
export function zipFiles(files) {
  const chunks = [], directory = []; let offset = 0;
  for (const [filename, raw] of files) {
    const name = Buffer.from(filename), bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw), compressed = deflateRawSync(bytes, { level: 3 }), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    chunks.push(header, name, compressed); directory.push(entry, name); offset += header.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}
function csvCell(value) { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }
export function transcriptFiles(conversation, messages, warnings, at) {
  const title = conversation.name || '對話';
  const csv = '\ufeff' + [['訊息ID', '平台', '顧客', '方向', '時間', '內容', '附件'], ...messages.map(m => [m.id, conversation.provider, title, m.direction === 'outgoing' ? '客服' : '顧客', new Date(m.sentAt).toISOString(), m.text, m.file || m.attachment?.name || ''])].map(row => row.map(csvCell).join(',')).join('\r\n');
  const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:15px system-ui;max-width:900px;margin:40px auto;padding:20px;color:#243247}article{padding:16px;border-bottom:1px solid #ddd}p{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#68788c}</style><h1>${escapeHtml(title)}</h1><p>${escapeHtml(conversation.provider)} · ${escapeHtml(conversation.status)} · 匯出 ${escapeHtml(new Date(at).toISOString())}</p>${messages.map(m => `<article><small>${m.direction === 'outgoing' ? '客服' : '顧客'} · ${escapeHtml(new Date(m.sentAt).toISOString())}</small><p>${escapeHtml(m.text)}</p>${m.file ? `<a href="${escapeHtml(m.file)}">${escapeHtml(m.attachment?.name || '附件')}</a>` : m.attachment ? '<small>附件未包含，請查看說明。</small>' : ''}</article>`).join('')}<h2>匯出說明</h2>${warnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}</html>`;
  return [['conversation.html', html], ['messages.csv', csv], ['messages.json', JSON.stringify({ conversation, exportedAt: at, messages, warnings }, null, 2)]];
}
