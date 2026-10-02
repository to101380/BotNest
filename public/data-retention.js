const DAY = 86400000;
const date = at => at ? new Date(at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚無紀錄';
export function createDataRetention({ request = async (user, path = '', options = {}) => {
  const response = await fetch('/api/ai/retention' + path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (path.startsWith('/download') && !path.includes('volume=') && response.ok) return response.blob();
  const data = await response.json(); if (!response.ok) throw Error(data.error || '資料管理暫時無法使用。'); return data;
} } = {}) {
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/data-retention.css'; document.head.append(style);
  const root = document.createElement('section'); root.className = 'data-retention'; root.hidden = true;
  root.innerHTML = `<header><div><h2>資料與儲存</h2><p>保留需要的對話，定期整理過期資料。</p></div><span class="retention-state"></span></header><div class="retention-rules"><div><strong>365 天</strong><span>文字訊息 · 每則分別計算</span></div><div><strong>90 天</strong><span>圖片、語音與文件</span></div><div><strong>30 天</strong><span>垃圾匣 · 可提前還原</span></div></div><p class="retention-start"></p><div class="retention-counts"></div><p class="retention-last"></p><div class="retention-controls"><button type="button" class="retention-primary" data-action="export">匯出全部對話</button><button type="button" data-action="scan">盤點到期資料</button><button type="button" data-action="enable">啟用自動清除</button></div><details><summary>保留與備份規則</summary><p>第一次啟用或縮短期限，都保留至少 14 天準備期。已完成對話依相同期限清除；垃圾匣收到顧客新訊息會回到處理中。姓名、標籤、備註保留。</p><p>清除只處理 BotNest 儲存的資料；平台上的原始訊息不會被刪除。附件到期後留下提示。每天分批整理，資料多時會持續接續處理。</p><p>備份含 HTML、CSV、JSON 與可取得的附件，一般備份整合成一個 ZIP，超過約 100 MB 才分檔；解壓縮後開啟 index.html 即可閱讀。備份下載限原帳號，7 天後刪除；外部平台不提供或已到期的附件會列在匯出說明。未匯出不會阻止自動清除，備份不會永久代存，也不提供自動還原匯入。雲端儲存目前另有 7 天復原保留，刪除檔案後的實際用量可能延後下降。</p></details><div class="retention-backup-heading"><div><h3>對話備份</h3><p>下載後解壓縮，開啟 index.html 閱讀對話。</p></div><span>保留 7 天</span></div><div class="retention-jobs"></div><details class="retention-history"><summary>資料盤點與處理紀錄</summary><div class="retention-scans"></div></details><p class="retention-feedback" role="status" aria-live="polite"></p>`;
  document.getElementById('account-page').append(root);
  const dialog = document.createElement('dialog'); dialog.className = 'retention-dialog'; dialog.innerHTML = `<h2>啟用資料自動清除</h2><p class="retention-confirm-text"></p><p>到期資料將永久刪除，請先下載需要的備份。未匯出仍會依期限清除。</p><label><input type="checkbox">我已確認影響範圍與保留期限</label><div><button type="button" data-action="cancel">取消</button><button type="button" data-action="confirm" class="retention-primary" disabled>確認啟用</button></div>`; document.body.append(dialog);
  const feedback = root.querySelector('.retention-feedback'); let user = null, data = null, generation = 0, busy = false, timer = null, lastLoad = 0, watchedJob = null, pendingDownload = null; const downloaded = new Map(), downloading = new Set(), expanded = new Set();
  function message(text, error = false) { feedback.textContent = text; feedback.classList.toggle('error', error); }
  function controls(on) { busy = on; for (const button of root.querySelectorAll('button')) button.disabled = on; }
  function paint() {
    if (!data) return;
    const { policy: p, preview: v, jobs } = data, effective = p.enabled && p.effectiveAt <= Date.now();
    root.querySelectorAll('.retention-rules strong').forEach((node, i) => { node.textContent = `${[p.textDays, p.attachmentDays, p.trashDays][i]} 天`; });
    root.querySelector('.retention-state').textContent = effective ? '自動清除已啟用' : p.enabled ? '準備期' : '等待啟用';
    root.querySelector('.retention-start').textContent = p.enabled ? `最早開始清除：${date(p.effectiveAt)}（台北時間）。` : '目前不會自動刪除。完成盤點並確認啟用後，會提供 14 天準備期。';
    const counts = root.querySelector('.retention-counts'); counts.replaceChildren();
    if (v) for (const [label, count] of [['到期文字訊息', v.messagesDue], ['到期附件', v.filesDue], ['到期垃圾匣對話', v.trashDue], ['7 天內到期文字（含已到期）', v.messagesIn7Days], ['7 天內到期附件（含已到期）', v.filesIn7Days], ['7 天內到期垃圾匣（含已到期）', v.trashIn7Days]]) { const item = document.createElement('div'), value = document.createElement('strong'), name = document.createElement('span'); value.textContent = Number(count || 0).toLocaleString('zh-TW'); name.textContent = label; item.append(value, name); counts.append(item); }
    else counts.textContent = '尚未盤點資料，請先按「盤點到期資料」。';
    root.querySelector('.retention-last').textContent = v ? `上次盤點：${date(v.finishedAt)}。檢查 ${v.messages || 0} 則訊息、${v.files || 0} 個檔案，檔案約 ${((v.fileBytes || 0) / 1048576).toFixed(1)} MB。清除 ${v.deletedMessages || 0} 則訊息、${v.deletedFiles || 0} 個檔案；數字為該次處理範圍，不等同 Firebase 總容量。` : '盤點會在背景執行，不需保持此頁開啟。';
    root.querySelector('[data-action="enable"]').textContent = p.enabled ? '暫停自動清除' : '啟用自動清除';
    const list = root.querySelector('.retention-jobs'), scans = root.querySelector('.retention-scans');
    list.replaceChildren(); scans.replaceChildren();
    const replacements = new Set(jobs.filter(j => j.sourceJobId && !['failed', 'expired', 'cancelled'].includes(j.status)).map(j => j.sourceJobId));
    const exports = jobs.filter(j => j.type === 'export' && !replacements.has(j.id));
    if (!exports.length) list.textContent = '尚無備份，按「匯出全部對話」開始。';
    if (!jobs.some(j => j.type !== 'export')) scans.textContent = '尚無盤點紀錄。';
    for (const j of [...exports, ...jobs.filter(j => j.type !== 'export')]) {
      const row = document.createElement('article'), info = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
      const status = ({ queued: '準備中', working: j.stage === 'packaging' ? '正在整理下載檔案' : '正在收集對話', ready: '可下載', expired: '已到期', failed: '處理失敗', cancelled: '設定已變更' })[j.status] || '處理中';
      row.className = 'retention-job'; title.textContent = `${j.type === 'export' ? j.scope || '對話備份' : '資料盤點'} · ${j.type !== 'export' && j.status === 'ready' ? '已完成' : status}`;
      detail.textContent = j.type === 'export' ? `${date(j.createdAt)} · ${Number(j.messages || 0).toLocaleString('zh-TW')} 則訊息${j.status === 'ready' ? ` · ${((j.downloadFiles?.reduce((n, f) => n + f.bytes, 0) || j.bytes || 0) / 1048576).toFixed(1)} MB` : ''}` : date(j.createdAt);
      info.append(title, detail); row.append(info);
      if (j.type === 'export' && ['queued', 'working'].includes(j.status)) {
        const progress = document.createElement('progress'); progress.setAttribute('aria-label', status); info.append(progress);
        const note = document.createElement('p'); note.textContent = '背景處理中，可以離開此頁；完成後回來下載。'; info.append(note);
      }
      if (j.type === 'export' && j.status === 'ready' && j.parts) {
        const files = j.downloadFiles || [], actions = document.createElement('div'); actions.className = 'retention-download-actions';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'retention-primary';
        button.textContent = files.length > 1 ? `下載檔案（${files.length} 個）` : '下載完整備份';
        button.disabled = downloading.has(j.id);
        if (files.length > 1) {
          const group = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = button.textContent; group.open = expanded.has(j.id);
          group.ontoggle = () => { if (group.open) expanded.add(j.id); else expanded.delete(j.id); }; group.append(summary);
          const note = document.createElement('p'); note.textContent = '備份較大，請保存以下所有檔案。'; group.append(note);
          files.forEach((f, i) => { const item = document.createElement('button'); item.type = 'button'; item.textContent = `${downloaded.get(j.id)?.has(i + 1) ? '已啟動下載 · ' : ''}檔案 ${i + 1} · ${(f.bytes / 1048576).toFixed(1)} MB`; item.disabled = downloading.has(j.id); item.onclick = () => void download(j, i + 1, item); group.append(item); }); actions.append(group);
        } else { button.onclick = () => files.length ? void download(j, 1, button) : void prepare(j); actions.append(button); }
        const expiry = document.createElement('small'); expiry.textContent = `下載期限 ${date(j.expiresAt)}`; actions.append(expiry); row.append(actions);
      } else if (j.type === 'export' && j.status === 'ready') {
        const note = document.createElement('p'); note.textContent = '此範圍沒有可匯出的訊息。'; info.append(note);
      }
      if (j.type === 'export' && j.warnings) {
        const note = document.createElement('p'); note.className = 'retention-warning'; note.textContent = `${j.warnings} 項附件缺漏說明 · 原因列在下載後各段對話的「匯出說明」。`; info.append(note);
      }
      if (j.type === 'export' && ['failed', 'expired', 'cancelled'].includes(j.status)) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新匯出'; retry.onclick = () => void operation('export', j.conversationId, j.remoteId); row.append(retry);
      }
      (j.type === 'export' ? list : scans).append(row);
    }
    if (watchedJob) {
      const current = jobs.find(j => j.id === watchedJob);
      if (current?.status === 'ready') { message(current.type === 'export' ? current.parts ? '備份已完成，可以下載。' : '此範圍沒有可匯出的訊息。' : '資料盤點已完成，數量已更新。'); watchedJob = null; }
      else if (current?.status === 'failed') { message('工作未完成，請重新執行。', true); watchedJob = null; pendingDownload = null; }
    }
    if (pendingDownload) {
      const current = jobs.find(j => j.id === pendingDownload);
      if (current?.status === 'ready' && current.downloadFiles?.length) {
        pendingDownload = null;
        if (current.downloadFiles.length === 1) queueMicrotask(() => void download(current, 1, document.createElement('button')));
        else { expanded.add(current.id); queueMicrotask(paint); message('大型備份已完成，請保存列出的所有下載檔案。'); }
      } else if (current && (['failed', 'expired', 'cancelled'].includes(current.status) || current.status === 'ready' && !current.parts)) pendingDownload = null;
    }
  }
  async function prepare(job) {
    if (busy || !user) return; const version = generation; controls(true); message('正在將舊備份整合成完整下載檔案…');
    try { const result = await request(user, '/package', { method: 'POST', body: JSON.stringify({ id: job.id }) }); if (version !== generation) return; watchedJob = result.id; pendingDownload = result.id; await load(); }
    catch (e) { if (version === generation) message(e.message, true); } finally { if (version === generation) controls(false); }
  }
  async function download(job, volume, button) {
    if (!user || downloading.has(job.id)) return; const current = user, version = generation; downloading.add(job.id); button.disabled = true; message('正在取得安全下載連結…');
    try {
      const result = await request(current, `/download?id=${encodeURIComponent(job.id)}&volume=${volume}`); if (version !== generation) return;
      const url = new URL(result.downloadUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com' || !url.pathname.startsWith('/planning-with-ai-52d58-botnest-media/botnest/backups/')) throw Error('下載連結無效，請重試。');
      const anchor = document.createElement('a'); anchor.href = url.href; anchor.rel = 'noreferrer'; anchor.referrerPolicy = 'no-referrer'; document.body.append(anchor); anchor.click(); anchor.remove();
      if (!downloaded.has(job.id)) downloaded.set(job.id, new Set()); downloaded.get(job.id).add(volume);
      message('已交給瀏覽器下載；完成後解壓縮並開啟 index.html。');
    } catch (e) { if (version === generation) message(e.message, true); }
    finally { downloading.delete(job.id); if (version === generation) { button.disabled = false; paint(); } }
  }
  async function load() {
    if (!user || root.hidden || document.hidden) return; const version = generation, current = user;
    try { const next = await request(current); if (version !== generation) return; data = next; lastLoad = Date.now(); paint(); }
    catch (e) { if (version === generation) message(e.message, true); }
    finally { if (version === generation && user && !root.hidden && !document.hidden) { clearTimeout(timer); timer = setTimeout(() => void load(), data?.jobs.some(j => ['working', 'queued'].includes(j.status)) ? 10000 : 60000); } }
  }
  async function operation(action, conversationId = null, remoteId = null) {
    if (busy || !user) return; const version = generation; controls(true); message('正在建立工作…');
    try { const result = await request(user, action === 'scan' ? '/scan' : '/export', { method: 'POST', body: JSON.stringify(conversationId ? { conversationId, ...(remoteId ? { remoteId } : {}) } : {}) }); if (version !== generation) return; watchedJob = result.id; if (action === 'export') pendingDownload = result.id; message(action === 'scan' ? '盤點已開始，完成後會顯示到期數量。' : '備份正在背景產生，完成後會在此頁開始下載；也可離開後回來手動下載。'); await load(); }
    catch (e) { if (version === generation) message(e.message, true); } finally { if (version === generation) controls(false); }
  }
  async function save(enabled) {
    if (busy || !data) return; const version = generation; controls(true);
    try { const p = data.policy; await request(user, '', { method: 'PUT', body: JSON.stringify({ textDays: p.textDays, attachmentDays: p.attachmentDays, trashDays: p.trashDays, revision: p.revision, enabled, confirm: enabled }) }); if (version !== generation) return; dialog.close(); await load(); message(enabled ? '已啟用，準備期結束後才開始清除。請先下載需要的備份。' : '已暫停後續清除；已清除的資料無法恢復。'); }
    catch (e) { if (version === generation) { dialog.close(); message(e.message, true); } } finally { if (version === generation) controls(false); }
  }
  root.querySelector('[data-action="scan"]').onclick = () => void operation('scan'); root.querySelector('[data-action="export"]').onclick = () => void operation('export');
  root.querySelector('[data-action="enable"]').onclick = () => {
    if (!data) return; if (data.policy.enabled) { void save(false); return; }
    if (!data.preview || data.preview.policyRevision !== data.policy.revision || Date.now() - data.preview.finishedAt > DAY) { message('請先盤點到期資料，完成後再啟用。', true); return; }
    const v = data.preview; dialog.querySelector('.retention-confirm-text').textContent = `上次盤點：${v.messagesDue || 0} 則文字、${v.filesDue || 0} 個附件、${v.trashDue || 0} 段垃圾匣對話已到期。最早從 ${date(Math.max(data.policy.effectiveAt, Date.now() + 14 * DAY))} 開始，屆時會按實際到期資料分批清除。`;
    dialog.querySelector('input').checked = false; dialog.querySelector('[data-action="confirm"]').disabled = true; dialog.showModal();
  };
  dialog.querySelector('input').onchange = event => { dialog.querySelector('[data-action="confirm"]').disabled = !event.target.checked; };
  dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.close(); dialog.querySelector('[data-action="confirm"]').onclick = () => void save(true);
  window.addEventListener('botnest-export-conversation', event => { if (user && event.detail?.id) { void operation('export', event.detail.id); } });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden && user && !root.hidden) void load();
  });
  return { setSession(next, active) {
    if (user?.uid !== next?.uid) { generation++; data = null; watchedJob = null; pendingDownload = null; downloaded.clear(); expanded.clear(); downloading.clear(); lastLoad = 0; controls(false); message(''); if (dialog.open) dialog.close(); }
    user = next; root.hidden = !next || !active; clearTimeout(timer);
    if (next && active && Date.now() - lastLoad > 10000) void load();
  } };
}
