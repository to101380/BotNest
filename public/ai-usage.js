const labels = { line: "LINE", facebook: "Messenger", instagram: "Instagram", workspace: "後台操作", reply: "文字回覆", image: "讀圖與回覆", audio: "語音辨識", test: "測試對話", knowledge: "知識庫圖片辨識", completed: "已處理", pending: "待確認", uncertain: "結果待確認", failed: "請求失敗" };
const number = value => new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(value || 0);
const usd = value => `US$ ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value / 1e9)}`;
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
export function createAiUsage() {
  const root = node("section"); root.id = "usage-page"; root.hidden = true; root.setAttribute("aria-labelledby", "usage-title");
  document.getElementById("signed-in").append(root);
  const link = node("a", "AI 用量"); link.id = "nav-usage"; link.href = "#usage"; document.getElementById("nav-assistant").after(link);
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/ai-usage.css"; document.head.append(css);
  root.innerHTML = `<div class="usage-heading"><div><h1 id="usage-title" tabindex="-1">AI 用量與充值</h1><p>掌握每月 BotNest token 額度，讓客服服務持續運作。</p></div><button id="usage-refresh" type="button">重新整理</button></div>
    <section class="usage-panel usage-wallet" aria-labelledby="usage-wallet-title"><div class="usage-wallet-heading"><h2 id="usage-wallet-title">我的 token 額度</h2><span class="usage-badge">方案籌備中</span></div><p>訂閱方案將每月提供固定的 BotNest token。AI 處理的對話越多、內容越長，用量也會增加；額度用完後，可另外購買 token。</p>
    <div class="usage-cards"><div class="usage-card"><span>每月方案額度</span><strong>—</strong><small>每月贈送數量尚未公布</small></div><div class="usage-card"><span>本月已消耗</span><strong>—</strong><small>BotNest token 換算規則待公布</small></div><div class="usage-card usage-balance"><span>目前剩餘</span><strong>—</strong><small>額度與扣量啟用後顯示</small></div><div class="usage-card"><span>充值餘額</span><strong>—</strong><small>token 購買功能尚未開放</small></div></div>
    <p class="usage-muted">目前尚未啟用訂閱額度與 token 扣量，「—」代表尚未設定，不是 0 或無限額度。下方 AI 使用紀錄不等於已扣除的 BotNest token。</p></section>
    <section class="usage-panel usage-topup" aria-labelledby="usage-topup-title"><div><span class="usage-eyebrow">BOTNEST TOKEN</span><h2 id="usage-topup-title">充值 token</h2><p>需要處理更多顧客對話？之後可購買額外 token，補充可用額度。</p><p class="usage-muted" id="usage-topup-note">充值方案、價格、有效期限與扣量規則將於開放購買前公布。目前不提供付款，也不會自動收取超額費用。</p></div><button type="button" disabled aria-describedby="usage-topup-note">即將推出</button></section>
    <section class="usage-panel" aria-labelledby="usage-rules-title"><h2 id="usage-rules-title">BotNest token 怎麼使用？</h2><div class="usage-token-rules"><div><h3>文字回覆</h3><p>依 AI 讀取的內容與產生的回答換算，包含指示詞、相關知識及對話歷史。</p></div><div><h3>圖片辨識</h3><p>讀圖及產生回答會使用 AI，將依圖片處理與回覆用量換算。</p></div><div><h3>語音辨識</h3><p>語音轉文字與後續 AI 回覆會分別計入，再統一換算為 BotNest token。</p></div></div><p class="usage-muted">各功能的換算比例尚未公布。BotNest token 是平台統一額度單位，不等同供應商的原始 token；不會將一次回覆、一張圖片或一段語音直接視為 1 token。</p></section>
    <h2 class="usage-records-title">AI 使用紀錄</h2>
    <div class="usage-controls"><label>月份 <input id="usage-month" type="month" required></label><label id="usage-scope-label" hidden>檢視範圍 <select id="usage-scope"><option value="mine">我的商家</option><option value="all">所有商家（管理者）</option></select></label><span>台北時間 · 每月統計</span></div>
    <p id="usage-status" role="status" aria-live="polite"></p><div id="usage-content" hidden>
    <div id="usage-cards" class="usage-cards"></div>
    <p class="usage-muted">以下為選定月份的實際 AI 處理紀錄，從用量功能上線後開始記錄；先前用量不會補算。月份與檢視範圍僅套用於使用紀錄。</p>
    <section id="usage-cost" class="usage-panel" hidden><h2>AI 成本估算 <span class="usage-owner">僅管理者可見</span></h2><div id="usage-cost-values" class="usage-cards"></div><p id="usage-cost-note" class="usage-muted"></p><details><summary>費率與計算方式</summary><p>文字與讀圖：未快取輸入 × 輸入費率 ＋ 快取輸入 × 快取費率 ＋ 輸出 × 輸出費率。图片已包含於輸入 token，不能再加一次。語音辨識與後續回答分開記錄。</p><p>GPT-5.4 mini：每百萬輸入／快取／輸出 token 分別為 US$ 0.75／0.075／4.50。GPT-4o mini transcribe：每百萬輸入／輸出 token 為 US$ 1.25／5.00。費率版本：2026-09-27，僅適用標準 API。</p><p>依 API 回傳用量與呼叫當時費率估算；缺失用量不視為免費。不含稅、匯率、Firebase、渠道或其他服務費，最終以供應商帳單為準。</p><a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer">OpenAI 官方費率</a></details></section>
    <div class="usage-columns"><section class="usage-panel"><h2>使用明細</h2><div class="usage-table-wrap"><table><thead><tr><th>渠道／用途</th><th>處理次數</th><th>圖片</th><th>語音分鐘</th></tr></thead><tbody id="usage-breakdown"></tbody></table></div></section>
    <section class="usage-panel"><h2>每日 AI 請求</h2><p class="usage-muted">包含回覆、辨識及後台測試；語音後續回答是另一個請求。</p><div id="usage-days"></div></section></div>
    <section class="usage-panel"><h2>最近 50 筆 AI 請求</h2><div id="usage-events" class="usage-table-wrap"></div></section>
    <details class="usage-panel"><summary>哪些操作會計入用量？</summary><ul><li>文字：AI 讀取指示詞、相關知識、對話歷史並產生回答，算一次生成。拆成多個訊息泡泡不重複計算。</li><li>圖片：按實際送入 AI 的張數記錄，讀圖與回覆通常是同一個請求。</li><li>語音：記錄送交辨識的段數及可讀取的音訊時長，辨識後生成回答另計。無法取得的時長會註明。</li><li>後台測試、知識庫圖片辨識也會使用 AI，列在後台操作。</li><li>播放語音、查看圖片、真人回覆、手動編輯知識不消耗 AI token。檔案及渠道服務費不包含於此。</li><li>AI 已運算但未送出、系統重試或辨識失敗仍可能產生成本；請求失敗與待確認會分開呈現。</li></ul></details></div>`;
  const $ = id => root.querySelector(`#${id}`);
  const currentMonth = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
  $("usage-month").value = currentMonth(); $("usage-month").max = currentMonth();
  let user = null, active = false, version = 0, controller;
  function card(label, value, note) { const el = node("div", undefined, "usage-card"); el.append(node("span", label), node("strong", value), node("small", note)); return el; }
  function render(data) {
    $("usage-scope-label").hidden = !data.admin;
    const rows = Object.entries(data.buckets), sum = field => rows.reduce((total, [, value]) => total + (value[field] || 0), 0);
    const count = kinds => rows.filter(([key]) => kinds.some(kind => key.endsWith(`_${kind}`))).reduce((total, [, value]) => total + value.completed, 0);
    const missingDuration = sum("unknownDuration"), minutes = number(sum("audioMs") / 60000);
    $("usage-cards").replaceChildren(card("AI 回覆生成", number(count(["reply", "image"])), "完成生成；不等同成功送達"), card("送交 AI 讀圖", `${number(sum("images"))} 張`, "包含知識庫圖片辨識"), card("語音辨識", `${number(count(["audio"]))} 段`, `${minutes} 分鐘${missingDuration ? ` · ${missingDuration} 段時長未知` : "（送交辨識時長）"}`), card("後台 AI 操作", number(count(["test", "knowledge"])), "測試對話與知識庫圖片辨識"));
    $("usage-cost").hidden = !data.admin;
    $("usage-cost-values").replaceChildren();
    if (data.admin) {
      $("usage-cost-values").append(card("已知用量成本", usd(sum("nanoUsd")), "美元估算 · 不是商家售價"), card("輸入 token", number(sum("inputTokens")), `其中快取 ${number(sum("cachedTokens"))}`), card("輸出 token", number(sum("outputTokens")), "以 API 回傳用量為準"));
      $("usage-cost-note").textContent = `${sum("unknownCost")} 筆成本待確認 · ${sum("failed")} 筆請求失敗 · ${sum("pending")} 筆結果待確認。待確認成本未包含在上方金額。`;
    }
    $("usage-breakdown").replaceChildren();
    for (const [key, value] of rows) { const [provider, kind] = key.split("_"); const tr = node("tr"); for (const text of [`${labels[provider] || provider}／${labels[kind] || kind}`, `${number(value.completed)}／${number(value.requests)}`, number(value.images), `${number(value.audioMs / 60000)}${value.unknownDuration ? "＋未知" : ""}`]) tr.append(node("td", text)); $("usage-breakdown").append(tr); }
    if (!rows.length) { const tr = node("tr"), td = node("td", "這個月份尚無用量紀錄。"); td.colSpan = 4; tr.append(td); $("usage-breakdown").append(tr); }
    $("usage-breakdown").closest("section").querySelector("h2").textContent = "使用明細（完成／總請求）";
    $("usage-days").replaceChildren();
    const maximum = Math.max(1, ...data.days.map(day => day.requests));
    for (const day of data.days) { const row = node("div", undefined, "usage-day"), meter = document.createElement("meter"); meter.min = 0; meter.max = maximum; meter.value = day.requests; meter.setAttribute("aria-label", `${day.day}：${day.requests} 次`); row.append(node("span", day.day.slice(5)), meter, node("span", number(day.requests))); $("usage-days").append(row); }
    if (!data.days.length) $("usage-days").append(node("p", "累積使用後，這裡會顯示每天的用量。", "usage-muted"));
    $("usage-events").replaceChildren();
    if (!data.events.length) $("usage-events").append(node("p", data.scope === "all" ? "此處提供跨商家彙總；切換「我的商家」可查看個別請求。" : "尚無 AI 請求紀錄。", "usage-muted"));
    else {
      const table = node("table"), head = node("thead"), hr = node("tr"), body = node("tbody");
      for (const title of ["時間", "渠道", "用途", "狀態", ...(data.admin ? ["估算成本"] : [])]) hr.append(node("th", title)); head.append(hr);
      for (const event of data.events) { const tr = node("tr"); const values = [new Date(event.at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }), labels[event.provider] || event.provider, labels[event.kind] || event.kind, labels[event.status] || event.status]; if (data.admin) values.push(event.cost?.nanoUsd == null ? "待確認" : usd(event.cost.nanoUsd)); for (const value of values) tr.append(node("td", value)); body.append(tr); }
      table.append(head, body); $("usage-events").append(table);
    }
    $("usage-content").hidden = false;
    $("usage-status").textContent = data.firstAt ? `本月紀錄始於 ${new Date(data.firstAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}。失敗 ${sum("failed")} 筆，待確認 ${sum("pending")} 筆。` : "這個月份尚無紀錄；開始使用 AI 後即可查看。";
  }
  async function refresh() {
    if (!active || !user) return;
    const current = ++version; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    $("usage-content").hidden = true; $("usage-status").textContent = "正在讀取用量…"; $("usage-refresh").disabled = true;
    try {
      const token = await user.getIdToken(); if (current !== version) return;
      const query = new URLSearchParams({ month: $("usage-month").value, scope: $("usage-scope").value });
      const response = await fetch(`/api/ai/usage?${query}`, { signal, cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json(); if (current !== version) return;
      if (!response.ok) throw new Error(data.error || "用量暫時無法讀取。"); render(data);
    } catch (error) { if (current === version && error.name !== "AbortError") $("usage-status").textContent = error.message || "用量暫時無法讀取，請重試。"; }
    finally { if (current === version) $("usage-refresh").disabled = false; }
  }
  $("usage-refresh").addEventListener("click", refresh); $("usage-month").addEventListener("change", refresh); $("usage-scope").addEventListener("change", refresh);
  return { setSession(nextUser, visible) {
    const changed = user?.uid !== nextUser?.uid; if (changed || !visible) { version++; controller?.abort(); $("usage-content").hidden = true; for (const id of ["usage-cards", "usage-cost-values", "usage-cost-note", "usage-events", "usage-breakdown", "usage-days", "usage-status"]) $(id).replaceChildren(); $("usage-scope-label").hidden = true; $("usage-scope").value = "mine"; }
    const load = visible && (changed || !active); user = nextUser; active = !!nextUser && visible; root.hidden = !active; if (load) refresh();
  } };
}
