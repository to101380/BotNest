import { inflateRawSync } from 'node:zlib';
import { zipFiles } from './backup-zip.js';
import { escapeHtml } from './retention-policy.js';

export const VOLUME_BYTES = 100 * 1024 * 1024;
const fail = () => Object.assign(new Error('備份檔案不完整，請重新匯出。'), { status: 503 });

// Source chunks are our own bounded ZIPs. Reuse compressed entries rather than
// inflating/recompressing every attachment or buffering the complete export.
function entries(bytes, prefix) {
  if (bytes.length < 22 || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50) throw fail();
  const end = bytes.length - 22, count = bytes.readUInt16LE(end + 10);
  let pos = bytes.readUInt32LE(end + 16);
  const rows = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw fail();
    const size = bytes.readUInt32LE(pos + 20), length = bytes.readUInt16LE(pos + 28);
    const name = bytes.subarray(pos + 46, pos + 46 + length).toString('utf8');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(v => v === '..' || v === '.') || /[\x00-\x1f]/.test(name)) throw fail();
    const local = bytes.readUInt32LE(pos + 42);
    if (local + 30 > pos || bytes.readUInt32LE(local) !== 0x04034b50) throw fail();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + size > pos || bytes.readUInt16LE(pos + 10) !== 8) throw fail();
    rows.push({ name: Buffer.from(prefix + name), central: bytes.subarray(pos, pos + 46), compressed: bytes.subarray(start, start + size) });
    pos += 46 + length + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
  }
  if (pos !== end) throw fail();
  return rows;
}

export async function downloadPlan(bucket, prefix, job) {
  if (!Number.isSafeInteger(job.parts) || job.parts < 1 || job.parts > 10000) throw fail();
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true, maxResults: 1000 });
  const byName = new Map(files.map(file => [file.name, file]));
  const volumes = []; let volume = { parts: [], bytes: 0 };
  for (let part = 1; part <= job.parts; part++) {
    const file = byName.get(prefix + `part-${String(part).padStart(6, '0')}.zip`);
    if (!file) throw fail();
    const metadata = file.metadata?.size ? file.metadata : (await file.getMetadata())[0];
    const bytes = Number(metadata.size);
    if (!Number.isSafeInteger(bytes) || bytes < 22 || bytes > 32 * 1024 * 1024) throw fail();
    if (volume.parts.length && volume.bytes + bytes > VOLUME_BYTES) { volumes.push(volume); volume = { parts: [], bytes: 0 }; }
    volume.parts.push(part); volume.bytes += bytes;
  }
  if (volume.parts.length) volumes.push(volume);
  return volumes;
}

export async function* streamBackup(bucket, prefix, job, volume, number, total) {
  const links = [];
  const directory = []; let offset = 0, count = 0;
  const sources = volume.parts.map(part => async () => (await bucket.file(prefix + `part-${String(part).padStart(6, '0')}.zip`).download())[0]);
  for (let i = 0; i <= sources.length; i++) {
    const part = volume.parts[i], folder = part ? `conversations/${String(part).padStart(6, '0')}/` : '';
    const overview = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BotNest 對話備份</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px;color:#243247}li{margin:12px 0}a{color:#087bed}</style><h1>BotNest 對話備份</h1><p>匯出範圍：${job.conversationId ? '指定對話' : '全部對話'} · 開始時間 ${escapeHtml(new Date(job.snapshotAt || job.createdAt).toISOString())}</p><p>備份總計 ${job.messages || 0} 則訊息 · 下載檔案 ${number} / ${total}</p><p>先解壓縮整個 ZIP，再開啟本檔閱讀。每段資料含 HTML、CSV、JSON 與可取得的附件；同一對話可能分成數段。</p><p>${job.warnings || 0} 項附件缺漏說明，詳見各段對話。平台已收回、到期或無法提供的檔案不在備份內。此備份不是平台完整歷史或一致性快照。</p><ul>${links.join('')}</ul></html>`;
    const bytes = i < sources.length ? await sources[i]() : zipFiles([['index.html', overview], ['README.txt', '先解壓縮整個 ZIP，再開啟 index.html 閱讀對話。大型備份請保存所有下載檔案。']]);
    if (bytes.length > 32 * 1024 * 1024) throw fail();
    const rows = entries(bytes, folder);
    if (part) {
      const transcript = rows.find(row => row.name.toString() === folder + 'messages.json');
      let label = `對話內容 ${part}`;
      if (transcript) { const value = JSON.parse(inflateRawSync(transcript.compressed, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8')); label = `${String(value.conversation?.provider || '').slice(0, 30)} · ${String(value.conversation?.name || '顧客').slice(0, 100)} · ${value.messages?.length || 0} 則訊息（第 ${part} 段）`; }
      links.push(`<li><a href="${folder}conversation.html">${escapeHtml(label)}</a></li>`);
    }
    for (const row of rows) {
      if (++count > 60000 || row.name.length > 65535) throw fail();
      const header = Buffer.alloc(30), central = Buffer.from(row.central);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
      row.central.copy(header, 14, 16, 28); header.writeUInt16LE(row.name.length, 26);
      central.writeUInt16LE(row.name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt32LE(offset, 42);
      directory.push(central, row.name); yield header; yield row.name; yield row.compressed;
      offset += 30 + row.name.length + row.compressed.length;
    }
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  yield central; yield end;
}
