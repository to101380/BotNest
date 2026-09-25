import { showAiModel } from "./ai-model.js";
const $ = id => document.getElementById(id);
const date = value => new Date(value).toLocaleString("zh-TW", { dateStyle: "short", timeStyle: "short" });
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };

export function createAiSettings() {
  const root = $("assistant-page");
  root.innerHTML = `
    <div class="assistant-header"><div><span class="assistant-eyebrow">BOTNEST AI</span><h1 id="assistant-title" tabindex="-1">AI 助理</h1><p>設定品牌知識，讓回覆更貼近你。</p><p class="assistant-model"><img src="/openai-icon.png" alt="" width="18" height="18"><span id="assistant-model-name" aria-live="polite">正在讀取模型…</span></p></div><div class="assistant-header-actions"><span id="assistant-live" class="assistant-badge">讀取中</span><button id="assistant-save" class="assistant-primary" type="button">儲存設定</button></div></div>
    <div class="assistant-overview"><div><span class="assistant-spark" aria-hidden="true">✦</span><div><strong>準備好，再開始回覆</strong><p>先設定角色與知識，透過測試確認，再開啟自動回覆。</p></div></div><div class="assistant-metrics"><span><strong id="assistant-knowledge-count">—</strong>啟用知識</span><span><strong id="assistant-channel-count">—</strong>回覆渠道</span></div></div>
    <div class="assistant-tabs" role="tablist" aria-label="AI 客服設定分頁">
      <button id="assistant-tab-persona" role="tab" aria-selected="true" aria-controls="assistant-persona" data-tab="persona">身分與語氣</button><button id="assistant-tab-knowledge" role="tab" aria-selected="false" aria-controls="assistant-knowledge" data-tab="knowledge" tabindex="-1">知識庫</button><button id="assistant-tab-rules" role="tab" aria-selected="false" aria-controls="assistant-rules" data-tab="rules" tabindex="-1">回覆規則</button><button id="assistant-tab-test" role="tab" aria-selected="false" aria-controls="assistant-test" data-tab="test" tabindex="-1">測試對話</button>
    </div>
    <dialog id="knowledge-loading" class="knowledge-loading" aria-labelledby="knowledge-loading-title" aria-describedby="knowledge-loading-detail"><div role="status" aria-live="polite"><span class="knowledge-loading-spinner" aria-hidden="true"></span><h2 id="knowledge-loading-title">正在上傳檔案…</h2><p id="knowledge-loading-detail">請稍候，完成後會開啟文字草稿。</p></div></dialog>
    <p id="assistant-status" role="status" aria-live="polite"></p>
    <section id="assistant-persona" role="tabpanel" aria-labelledby="assistant-tab-persona" class="assistant-panel">
      <div class="assistant-two-col"><div class="assistant-card"><div class="assistant-card-title"><span class="assistant-step">01</span><div><h2>品牌與語氣</h2><p>角色、商家資訊與說話方式，會套用至所有啟用的渠道。</p></div></div>
        <label for="assistant-role">客服角色</label><input id="assistant-role" maxlength="120" placeholder="例如：博序的線上客服助理">
        <label for="assistant-businessInfo">商家介紹與基本資訊</label><textarea id="assistant-businessInfo" rows="6" maxlength="6000" placeholder="介紹你的品牌、服務對象、營業時間與聯絡方式。詳細商品及政策可放在知識庫。"></textarea>
        <div class="assistant-fields"><div><label for="assistant-tone">說話語氣</label><input id="assistant-tone" maxlength="200" placeholder="親切、簡潔、有禮貌"></div><div><label for="assistant-language">回覆語言</label><input id="assistant-language" maxlength="80" placeholder="繁體中文"></div></div>
      </div><div class="assistant-card"><div class="assistant-card-title"><span class="assistant-step">02</span><div><h2>回覆原則</h2><p>清楚告訴 AI 哪些內容需要交給真人。</p></div></div>
        <label for="assistant-forbidden">禁止回答或承諾的內容</label><textarea id="assistant-forbidden" rows="5" maxlength="2000" placeholder="例如：不得承諾折扣、不得判定退款、不得猜測訂單狀態。"></textarea>
        <label for="assistant-instructions">客服指示詞</label><textarea id="assistant-instructions" rows="7" maxlength="4000" placeholder="可補充問候方式、回答長度或服務流程。"></textarea><p class="assistant-muted">與角色、商家資訊一起提供給 AI，套用至所有啟用的渠道。</p>
        <details class="assistant-tip"><summary>進一步了解</summary><p>AI 無法直接退款或修改訂單。需要實際處理的要求，會交由真人接手。</p></details>
      </div></div>
    </section>
    <section id="assistant-knowledge" role="tabpanel" aria-labelledby="assistant-tab-knowledge" class="assistant-panel" hidden>
      <div class="assistant-section-heading"><div><h2>品牌知識庫</h2><p>商品、價格、營業時間、配送與退換貨政策、常見問題。</p></div><button id="knowledge-add" class="assistant-primary" type="button">＋ 新增知識</button></div>
      <div class="knowledge-import"><div><strong>匯入現有資料</strong><p>PDF、Word（.docx）、TXT、Markdown、JPG、PNG、WebP · 每份 5 MB / 40,000 字</p></div><button id="knowledge-upload" class="assistant-secondary" type="button">上傳檔案</button><input id="knowledge-file" type="file" accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.webp" hidden><form id="knowledge-url-form"><label class="sr-only" for="knowledge-url">公開網頁網址</label><input id="knowledge-url" type="url" placeholder="https://你的商家網站" required><button class="assistant-secondary" type="submit">匯入網址</button></form></div>
      <p class="assistant-muted">圖片會交由 AI 辨識文字，請核對價格、數字及模糊字。匯入資料會先存為草稿。確認文字後啟用，AI 才會參考。網址擷取當下公開文字；掃描圖片 PDF、登入頁與動態網頁可改用貼上文字。</p>
      <div id="knowledge-list" class="knowledge-list"></div>
    </section>
    <section id="assistant-rules" role="tabpanel" aria-labelledby="assistant-tab-rules" class="assistant-panel" hidden>
      <div class="assistant-two-col"><div class="assistant-card"><div class="assistant-card-title"><span class="assistant-step">01</span><div><h2>渠道與時段</h2><p>總開關及各渠道設定會立即影響儲存後的新訊息。</p></div></div>
        <label class="assistant-toggle-row"><span><strong>啟用 AI 自動回覆</strong><small>新收到的文字訊息交由 AI 處理</small></span><input id="assistant-enabled" type="checkbox"></label>
        <fieldset class="assistant-checks"><legend>回覆渠道</legend><label><input id="assistant-line" type="checkbox"> LINE</label><label><input id="assistant-facebook" type="checkbox"> Messenger</label><label><input id="assistant-instagram" type="checkbox"> Instagram</label></fieldset><p id="assistant-connections" class="assistant-muted"></p>
        <label for="assistant-hours-mode">回覆時段</label><select id="assistant-hours-mode"><option value="always">全天自動回覆</option><option value="inside">只在營業時間回覆</option><option value="outside">只在非營業時間回覆</option></select>
        <div class="assistant-fields"><div><label for="assistant-start">營業開始</label><input id="assistant-start" type="time"></div><div><label for="assistant-end">營業結束</label><input id="assistant-end" type="time"></div></div>
        <fieldset class="assistant-days"><legend>營業日</legend>${["日", "一", "二", "三", "四", "五", "六"].map((day, index) => `<label><input type="checkbox" value="${index}" name="assistant-day"><span>${day}</span></label>`).join("")}</fieldset>
        <label for="assistant-timezone">時區</label><select id="assistant-timezone"><option value="Asia/Taipei">台北（Asia/Taipei）</option><option value="Asia/Hong_Kong">香港（Asia/Hong_Kong）</option><option value="Asia/Tokyo">東京（Asia/Tokyo）</option><option value="America/Los_Angeles">洛杉磯（America/Los_Angeles）</option><option value="UTC">UTC</option></select>
      </div><div class="assistant-card"><div class="assistant-card-title"><span class="assistant-step">02</span><div><h2>真人接手</h2><p>避免 AI 與客服同時回答，讓需要協助的顧客有明確狀態。</p></div></div>
        <label class="assistant-toggle-row"><span><strong>商業資訊需有知識依據</strong><small>資料不足或引用無效時，轉交真人</small></span><input id="assistant-requireKnowledge" type="checkbox"></label>
        <label for="assistant-keywords">立即轉真人的關鍵字</label><textarea id="assistant-keywords" rows="3" placeholder="退款、客訴、投訴、真人客服"></textarea><p class="assistant-muted">以逗號或換行分隔，最多 30 個。AI 也會判斷要求真人及超出能力的情境。</p>
        <label for="assistant-humanPauseMinutes">真人從訊息中心回覆後，暫停 AI（分鐘）</label><input id="assistant-humanPauseMinutes" type="number" min="1" max="1440">
        <label for="assistant-handoffMessage">轉真人時的通知文字</label><textarea id="assistant-handoffMessage" rows="4" maxlength="500"></textarea>
        <details class="assistant-tip"><summary>進一步了解</summary><p>轉真人的對話會持續暫停 AI，直到你在訊息中心按「交回 AI」。測試區會顯示相同判斷，不會傳給顧客。</p></details>
      </div></div>
    </section>
    <section id="assistant-test" role="tabpanel" aria-labelledby="assistant-tab-test" class="assistant-panel" hidden>
      <div class="assistant-section-heading"><div><h2>正式啟用前，先聊聊看</h2><p>使用已儲存的設定與啟用知識，不會傳到 LINE 或 Messenger。測試會使用模型額度。</p></div><button id="assistant-test-clear" class="assistant-secondary" type="button">清空對話</button></div>
      <div class="assistant-test-layout"><div class="assistant-test-chat"><div class="assistant-test-top"><label for="assistant-test-provider">模擬渠道</label><select id="assistant-test-provider"><option value="line">LINE</option><option value="facebook">Messenger</option><option value="instagram">Instagram</option></select><span>測試模式</span></div><div id="assistant-test-messages" aria-live="polite"><div class="assistant-test-empty"><span aria-hidden="true">✦</span><strong>從顧客的第一個問題開始</strong><p>例如「你們幾點營業？」或「我想申請退款」。</p></div></div><form id="assistant-test-form"><label class="sr-only" for="assistant-test-question">模擬顧客提問</label><textarea id="assistant-test-question" rows="2" maxlength="2000" placeholder="輸入顧客可能會問的問題…" required></textarea><button id="assistant-test-send" class="assistant-primary" type="submit">測試回覆</button></form></div><div class="assistant-card assistant-evidence"><h2>這次回答的依據</h2><p id="assistant-test-decision" class="assistant-muted">傳送問題後，這裡會顯示判斷與引用來源。</p><div id="assistant-test-sources"></div></div></div>
    </section>
    <dialog id="knowledge-dialog" class="knowledge-dialog"><form id="knowledge-form"><div class="assistant-section-heading"><h2 id="knowledge-dialog-title">新增知識</h2><button id="knowledge-close" type="button" aria-label="關閉知識編輯">×</button></div><label for="knowledge-title">標題</label><input id="knowledge-title" maxlength="120" required placeholder="例如：配送與退換貨政策"><label for="knowledge-content">知識內容</label><textarea id="knowledge-content" rows="15" maxlength="40000" required placeholder="請提供已確認的商品資訊、政策或問答內容。"></textarea><label class="assistant-toggle-row"><span>儲存後啟用，供 AI 參考</span><input id="knowledge-enabled" type="checkbox"></label><p id="knowledge-editor-status" role="status"></p><div class="knowledge-dialog-actions"><button class="assistant-primary" type="submit">儲存知識</button></div></form></dialog>`;
  let user, active = false, epoch = 0, controller = new AbortController(), dirty = false, ready = false, saving = false, testing = false, importing = false, editing = null, items = [], testHistory = [];
  const fields = ["role", "businessInfo", "tone", "language", "forbidden", "instructions", "humanPauseMinutes", "handoffMessage"];
  function status(value, error = false) { $("assistant-status").textContent = value; $("assistant-status").classList.toggle("error", error); }
  async function api(path, options = {}) {
    const generation = epoch, current = user, signal = controller.signal;
    if (!active || !current) throw new DOMException("Inactive", "AbortError");
    const token = await current.getIdToken(); if (generation !== epoch) throw new DOMException("Session changed", "AbortError");
    const response = await fetch(`/api/ai/${path}`, { ...options, signal, cache: "no-store", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const data = await response.json().catch(() => ({ error: "AI 客服服務暫時無法使用。" }));
    if (generation !== epoch) throw new DOMException("Session changed", "AbortError");
    if (!response.ok || data.error) throw new Error(data.error || "操作未完成。"); return data;
  }
  const report = error => { if (error.name !== "AbortError") status(error.message, true); };
  function controls() {
    for (const field of root.querySelectorAll('#assistant-persona input, #assistant-persona textarea, #assistant-rules input, #assistant-rules textarea, #assistant-rules select')) field.disabled = !ready || saving;
    $("assistant-save").disabled = !ready || saving; $("assistant-save").textContent = saving ? "儲存中…" : dirty ? "儲存變更" : "儲存設定";
    $("assistant-test-send").disabled = !ready || testing || dirty; $("assistant-test-send").textContent = testing ? "正在產生回覆…" : dirty ? "請先儲存設定" : "測試回覆";
    $("knowledge-add").disabled = !ready;
    $("knowledge-upload").disabled = !ready || importing; $("knowledge-url-form").querySelector("button").disabled = !ready || importing;
    $("assistant-test-clear").disabled = testing;
  }
  function markDirty() { dirty = true; controls(); status("設定已修改，請按右上角「儲存變更」。"); }
  for (const id of ["assistant-persona", "assistant-rules"]) $(id).addEventListener("input", markDirty);
  function fill(settings) {
    showAiModel($("assistant-model-name"), settings.model);
    for (const field of fields) $("assistant-" + field).value = settings[field] ?? "";
    for (const field of ["enabled", "requireKnowledge"]) $("assistant-" + field).checked = !!settings[field];
    $("assistant-line").checked = settings.channels.line; $("assistant-facebook").checked = settings.channels.facebook; $("assistant-instagram").checked = settings.channels.instagram;
    $("assistant-hours-mode").value = settings.schedule.mode; $("assistant-start").value = settings.schedule.start; $("assistant-end").value = settings.schedule.end;
    const zone = $("assistant-timezone"); if (![...zone.options].some(option => option.value === settings.schedule.timezone)) zone.append(new Option(settings.schedule.timezone, settings.schedule.timezone)); zone.value = settings.schedule.timezone;
    for (const day of root.querySelectorAll('[name="assistant-day"]')) day.checked = settings.schedule.days.includes(Number(day.value));
    $("assistant-keywords").value = settings.handoffKeywords.join("、");
    $("assistant-live").textContent = !settings.configured ? "待設定 API Key" : settings.enabled ? "AI 自動回覆已開啟" : "AI 自動回覆已關閉";
    $("assistant-live").classList.toggle("active", settings.enabled && settings.configured);
    $("assistant-channel-count").textContent = Number(settings.channels.line) + Number(settings.channels.facebook) + Number(settings.channels.instagram);
    dirty = false;
  }
  function formSettings() {
    const data = Object.fromEntries(fields.map(field => [field, $("assistant-" + field).value]));
    return { ...data, humanPauseMinutes: Number(data.humanPauseMinutes), enabled: $("assistant-enabled").checked, requireKnowledge: $("assistant-requireKnowledge").checked,
      channels: { line: $("assistant-line").checked, facebook: $("assistant-facebook").checked, instagram: $("assistant-instagram").checked }, schedule: { mode: $("assistant-hours-mode").value, timezone: $("assistant-timezone").value, days: [...root.querySelectorAll('[name="assistant-day"]:checked')].map(day => Number(day.value)), start: $("assistant-start").value, end: $("assistant-end").value },
      handoffKeywords: $("assistant-keywords").value.split(/[,，、\n]+/).map(value => value.trim()).filter(Boolean) };
  }
  $("assistant-save").addEventListener("click", async () => {
    if (saving || !ready) return; saving = true; controls();
    try { const result = await api("settings", { method: "PUT", body: JSON.stringify(formSettings()) }); fill(result.settings); status("設定已儲存，會套用到新的顧客訊息。"); }
    catch (error) { report(error); } finally { saving = false; controls(); }
  });
  function sources(container, values) {
    container.replaceChildren();
    if (!values?.length) { container.append(text("p", "這次沒有引用知識來源。", "assistant-muted")); return; }
    for (const source of values) { const details = document.createElement("details"); details.className = "assistant-source"; details.append(text("summary", source.title), text("p", source.excerpt)); container.append(details); }
  }
  function openEditor(item = null) {
    editing = item?.id || null; $("knowledge-title").value = item?.title || ""; $("knowledge-content").value = item?.content || ""; $("knowledge-enabled").checked = item?.enabled ?? true;
    $("knowledge-dialog-title").textContent = item ? "編輯知識" : "新增知識"; $("knowledge-editor-status").textContent = ""; $("knowledge-dialog").showModal();
  }
  function renderKnowledge() {
    $("assistant-knowledge-count").textContent = items.filter(item => item.enabled).length;
    const list = $("knowledge-list"); list.replaceChildren();
    if (!items.length) list.append(text("div", "知識庫還是空的。新增一份常見問題，或匯入你的商家資料。", "assistant-empty"));
    for (const item of items) {
      const row = document.createElement("article"); row.className = "knowledge-card";
      const icon = text("span", item.kind === "url" ? "↗" : item.kind === "file" ? "▤" : "≡", "knowledge-kind");
      const body = document.createElement("div"); body.className = "knowledge-copy"; body.append(text("h3", item.title), text("p", item.content.slice(0, 130)), text("small", `${item.content.length.toLocaleString()} 字 · 更新於 ${date(item.updatedAt)}`));
      const actions = document.createElement("div"); actions.className = "knowledge-actions";
      const toggle = text("button", item.enabled ? "已啟用" : "草稿", `assistant-badge ${item.enabled ? "active" : ""}`); toggle.type = "button"; toggle.setAttribute("aria-label", `${item.enabled ? "停用" : "啟用"} ${item.title}`);
      toggle.addEventListener("click", async () => { toggle.disabled = true; try { await api(`knowledge/${item.id}`, { method: "PUT", body: JSON.stringify({ title: item.title, content: item.content, enabled: !item.enabled }) }); await loadKnowledge(); status(item.enabled ? "知識已停用。" : "知識已啟用。"); } catch (error) { report(error); toggle.disabled = false; } });
      const edit = text("button", "編輯", "assistant-secondary"); edit.type = "button"; edit.addEventListener("click", () => openEditor(item));
      const remove = text("button", "×", "knowledge-remove"); remove.type = "button"; remove.setAttribute("aria-label", `刪除 ${item.title}`); remove.addEventListener("click", async () => { if (!confirm(`刪除「${item.title}」？AI 之後將不再參考這份資料。`)) return; remove.disabled = true; try { await api(`knowledge/${item.id}`, { method: "DELETE" }); await loadKnowledge(); status("知識已刪除。"); } catch (error) { report(error); remove.disabled = false; } });
      actions.append(toggle, edit, remove); row.append(icon, body, actions); list.append(row);
    }
  }
  async function loadKnowledge() { items = (await api("knowledge")).items; renderKnowledge(); }
  $("knowledge-add").addEventListener("click", () => openEditor()); $("knowledge-close").addEventListener("click", () => $("knowledge-dialog").close());
  $("knowledge-form").addEventListener("submit", async event => { event.preventDefault(); const button = event.submitter; button.disabled = true;
    try { await api(editing ? `knowledge/${editing}` : "knowledge", { method: editing ? "PUT" : "POST", body: JSON.stringify({ title: $("knowledge-title").value, content: $("knowledge-content").value, enabled: $("knowledge-enabled").checked }) }); $("knowledge-dialog").close(); await loadKnowledge(); status("知識已儲存。"); }
    catch (error) { if (error.name !== "AbortError") $("knowledge-editor-status").textContent = error.message; } finally { button.disabled = false; }
  });
  function showImportLoading(title) {
    $("knowledge-loading-title").textContent = title;
    if (!$("knowledge-loading").open) $("knowledge-loading").showModal();
  }
  $("knowledge-loading").addEventListener("cancel", event => event.preventDefault());
  async function importKnowledge(body) {
    if (importing) return; const generation = epoch; importing = true; controls(); showImportLoading(body.kind === "url" ? "正在匯入網頁…" : /\.(jpe?g|png|webp)$/i.test(body.name || "") ? "正在上傳並辨識圖片文字…" : "正在上傳並擷取文字…"); status(/\.(jpe?g|png|webp)$/i.test(body.name || "") ? "正在辨識圖片文字，完成後請核對內容…" : "正在擷取文字，完成後請檢查內容並啟用…");
    try { const result = await api("knowledge/import", { method: "POST", body: JSON.stringify(body) }); await loadKnowledge(); if (generation !== epoch) return; $("knowledge-loading").close(); openEditor(result.item); status("已匯入為草稿。確認內容後勾選啟用並儲存。"); }
    catch (error) { report(error); } finally { if (generation === epoch) { importing = false; $("knowledge-loading").close(); controls(); } }
  }
  $("knowledge-url-form").addEventListener("submit", event => { event.preventDefault(); void importKnowledge({ kind: "url", url: $("knowledge-url").value }); });
  $("knowledge-upload").addEventListener("click", () => $("knowledge-file").click());
  $("knowledge-file").addEventListener("change", async () => { const generation = epoch, file = $("knowledge-file").files[0]; $("knowledge-file").value = ""; if (!file) return;
    if (file.size > 5 * 1024 * 1024) return status("檔案上限為 5 MB。", true);
    if (importing) return; showImportLoading("正在讀取檔案…");
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => null);
    if (generation !== epoch) return;
    if (data) await importKnowledge({ kind: "file", name: file.name, data }); else { $("knowledge-loading").close(); status("無法讀取檔案。", true); }
  });
  function chatBubble(content, role) { const bubble = text("div", content, `assistant-test-bubble ${role}`); $("assistant-test-messages").append(bubble); bubble.scrollIntoView({ block: "nearest" }); }
  $("assistant-test-form").addEventListener("submit", async event => {
    event.preventDefault(); if (testing || dirty || !ready) return;
    const question = $("assistant-test-question").value.trim(); if (!question) return;
    testing = true; controls(); $("assistant-test-messages").querySelector(".assistant-test-empty")?.remove(); chatBubble(question, "user"); $("assistant-test-question").value = "";
    try { const { result } = await api("test", { method: "POST", body: JSON.stringify({ question, history: testHistory.slice(-14), provider: $("assistant-test-provider").value }) });
      chatBubble(result.text || `未自動回覆：${result.reason}`, "assistant"); $("assistant-test-decision").textContent = `${result.action === "handoff" ? "轉真人" : result.action === "skipped" ? "不回覆" : "AI 回覆"} · ${result.reason}`; sources($("assistant-test-sources"), result.sources);
      testHistory.push({ role: "user", content: question }); if (result.text) testHistory.push({ role: "assistant", content: result.text.slice(0, 2000) }); status("測試完成。沒有傳送任何訊息給顧客。");
    } catch (error) { if (error.name !== "AbortError") { chatBubble(error.message, "error"); report(error); } } finally { testing = false; controls(); }
  });
  $("assistant-test-question").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$("assistant-test-send").disabled) $("assistant-test-form").requestSubmit(); } });
  $("assistant-test-clear").addEventListener("click", () => { testHistory = []; $("assistant-test-messages").replaceChildren(); $("assistant-test-sources").replaceChildren(); $("assistant-test-decision").textContent = "對話已清空，可以重新測試。"; });
  function selectTab(tab) {
    for (const button of root.querySelectorAll("[data-tab]")) { const selected = button.dataset.tab === tab; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; $("assistant-" + button.dataset.tab).hidden = !selected; }
  }
  const tabs = [...root.querySelectorAll("[data-tab]")];
  for (const [index, button] of tabs.entries()) { button.addEventListener("click", () => selectTab(button.dataset.tab)); button.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; tabs[next].focus(); selectTab(tabs[next].dataset.tab); }); }
  return { setSession(nextUser, visible) {
    const nextActive = !!nextUser && visible; if (user?.uid === nextUser?.uid && active === nextActive) return;
    $("knowledge-loading").close();
    epoch++; controller.abort(); controller = new AbortController(); user = nextUser; active = nextActive; ready = false; dirty = false; testing = false; saving = false; importing = false;
    showAiModel($("assistant-model-name"), null, "正在讀取模型…");
    items = []; testHistory = []; $("knowledge-dialog").close(); $("assistant-test-messages").replaceChildren(); $("assistant-test-sources").replaceChildren(); renderKnowledge(); controls();
    if (active) { status("正在讀取 AI 客服設定…"); void Promise.all([api("settings"), loadKnowledge()]).then(([data]) => { fill(data.settings); ready = true; $("assistant-connections").textContent = `已連接：${[data.connections.line ? "LINE" : "", data.connections.facebook ? "Messenger" : "", data.connections.instagram ? "Instagram" : ""].filter(Boolean).join("、") || "尚未連接渠道，可先設定與測試"}`; controls(); status(""); }).catch(error => { if (error.name !== "AbortError") showAiModel($("assistant-model-name"), null, "暫時無法讀取模型"); report(error); }); }
  } };
}
