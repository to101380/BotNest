const DAY = 86400000;
const date = at => at ? new Date(at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚無紀錄';
export function createDataRetention({ request = async (user, path = '', options = {}) => {
  const response = await fetch('/api/ai/retention' + path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || '資料管理暫時無法使用。'); return data;
} } = {}) {
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/data-retention.css'; document.head.append(style);
  const root = document.createElement('section'); root.className = 'data-retention'; root.hidden = true;
  root.innerHTML = `<header><div><h2>資料與儲存</h2><p>保留需要的對話，定期整理過期資料。</p></div><span class="retention-state"></span></header><div class="retention-rules"><div><strong>365 天</strong><span>文字訊息 · 每則分別計算</span></div><div><strong>90 天</strong><span>圖片、語音與文件</span></div><div><strong>30 天</strong><span>垃圾匣 · 可提前還原</span></div></div><p class="retention-start"></p><div class="retention-counts"></div><p class="retention-last"></p><div class="retention-controls"><button type="button" data-action="scan">盤點到期資料</button><button type="button" data-action="enable">啟用自動清除</button></div><details><summary>資料保留規則</summary><p>第一次啟用或縮短期限，都保留至少 14 天準備期。已完成對話依相同期限清除；垃圾匣收到顧客新訊息會回到處理中。姓名、標籤、備註保留。</p><p>清除只處理 BotNest 儲存的資料；平台上的原始訊息不會被刪除。附件到期後留下提示。每天分批整理，資料多時會持續接續處理。</p><p>超過保留期限的內容會從 BotNest 刪除，無法再於此查閱。</p></details><details class="retention-history"><summary>資料盤點與處理紀錄</summary><div class="retention-scans"></div></details><p class="retention-feedback" role="status" aria-live="polite"></p>`;
  document.getElementById('account-page').append(root);
  const dialog = document.createElement('dialog'); dialog.className = 'retention-dialog'; dialog.innerHTML = `<h2>啟用資料自動清除</h2><p class="retention-confirm-text"></p><p>到期資料將從 BotNest 永久刪除，無法再於此查閱；渠道上的原始訊息不受影響。</p><label><input type="checkbox">我已確認影響範圍與保留期限</label><div><button type="button" data-action="cancel">取消</button><button type="button" data-action="confirm" class="retention-primary" disabled>確認啟用</button></div>`; document.body.append(dialog);
  const feedback = root.querySelector('.retention-feedback'); let user = null, data = null, generation = 0, busy = false, timer = null, lastLoad = 0, watchedJob = null;
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
    const scans = root.querySelector('.retention-scans'); scans.replaceChildren();
    const scanJobs = jobs.filter(j => j.type === 'scan');
    if (!scanJobs.length) scans.textContent = '尚無盤點紀錄。';
    for (const j of scanJobs) {
      const row = document.createElement('article'), title = document.createElement('strong'), detail = document.createElement('p');
      const status = ({ queued: '準備中', working: '盤點中', ready: '已完成', expired: '已到期', failed: '處理失敗', cancelled: '設定已變更' })[j.status] || '處理中';
      title.textContent = '資料盤點 · ' + status; detail.textContent = date(j.createdAt); row.append(title, detail); scans.append(row);
    }
    if (watchedJob) {
      const current = scanJobs.find(j => j.id === watchedJob);
      if (current?.status === 'ready') { message('資料盤點已完成，數量已更新。'); watchedJob = null; }
      else if (current && ['failed', 'cancelled', 'expired'].includes(current.status)) { message('盤點未完成，請重新執行。', true); watchedJob = null; }
    }
  }
  async function load() {
    if (!user || root.hidden || document.hidden) return; const version = generation, current = user;
    try { const next = await request(current); if (version !== generation) return; data = next; lastLoad = Date.now(); paint(); }
    catch (e) { if (version === generation) message(e.message, true); }
    finally { if (version === generation && user && !root.hidden && !document.hidden) { clearTimeout(timer); timer = setTimeout(() => void load(), data?.jobs.some(j => ['working', 'queued'].includes(j.status)) ? 10000 : 60000); } }
  }
  async function operation() {
    if (busy || !user) return; const version = generation; controls(true); message('正在建立工作…');
    try { const result = await request(user, '/scan', { method: 'POST', body: '{}' }); if (version !== generation) return; watchedJob = result.id; message('盤點已開始，完成後會顯示到期數量。'); await load(); }
    catch (e) { if (version === generation) message(e.message, true); } finally { if (version === generation) controls(false); }
  }
  async function save(enabled) {
    if (busy || !data) return; const version = generation; controls(true);
    try { const p = data.policy; await request(user, '', { method: 'PUT', body: JSON.stringify({ textDays: p.textDays, attachmentDays: p.attachmentDays, trashDays: p.trashDays, revision: p.revision, enabled, confirm: enabled }) }); if (version !== generation) return; dialog.close(); await load(); message(enabled ? '已啟用，準備期結束後會按保留期限清除。' : '已暫停後續清除；已清除的資料無法恢復。'); }
    catch (e) { if (version === generation) { dialog.close(); message(e.message, true); } } finally { if (version === generation) controls(false); }
  }
  root.querySelector('[data-action="scan"]').onclick = () => void operation();
  root.querySelector('[data-action="enable"]').onclick = () => {
    if (!data) return; if (data.policy.enabled) { void save(false); return; }
    if (!data.preview || data.preview.policyRevision !== data.policy.revision || Date.now() - data.preview.finishedAt > DAY) { message('請先盤點到期資料，完成後再啟用。', true); return; }
    const v = data.preview; dialog.querySelector('.retention-confirm-text').textContent = `上次盤點：${v.messagesDue || 0} 則文字、${v.filesDue || 0} 個附件、${v.trashDue || 0} 段垃圾匣對話已到期。最早從 ${date(Math.max(data.policy.effectiveAt, Date.now() + 14 * DAY))} 開始，屆時會按實際到期資料分批清除。`;
    dialog.querySelector('input').checked = false; dialog.querySelector('[data-action="confirm"]').disabled = true; dialog.showModal();
  };
  dialog.querySelector('input').onchange = event => { dialog.querySelector('[data-action="confirm"]').disabled = !event.target.checked; };
  dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.close(); dialog.querySelector('[data-action="confirm"]').onclick = () => void save(true);
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden && user && !root.hidden) void load();
  });
  return { setSession(next, active) {
    if (user?.uid !== next?.uid) { generation++; data = null; watchedJob = null; lastLoad = 0; controls(false); message(''); if (dialog.open) dialog.close(); }
    user = next; root.hidden = !next || !active; clearTimeout(timer);
    if (next && active && Date.now() - lastLoad > 10000) void load();
  } };
}
