export function insightRange(items, scope = "session", now = Date.now()) {
  const all = items.filter(m => !m.unsent && !["pending", "failed", "uncertain"].includes(m.status) && Number.isFinite(m.sentAt)).sort((a, b) => a.sentAt - b.sentAt);
  let start = 0;
  if (scope === "session") for (let i = 1; i < all.length; i++) if (all[i].sentAt - all[i - 1].sentAt > 86400000) start = i;
  let chosen = scope === "day" ? all.filter(m => m.sentAt >= now - 86400000) : scope === "recent" ? all.slice(-30) : all.slice(start);
  chosen = chosen.filter(m => typeof m.text === "string" && m.text.trim()); const original = chosen.length; chosen = chosen.slice(-80).map(m => ({ id: m.id, text: m.text.slice(0, 2000), direction: m.direction, sentAt: m.sentAt }));
  while (chosen.reduce((n, m) => n + m.text.length, 0) > 24000) chosen.shift();
  return { messages: chosen, limited: original !== chosen.length, boundary: start > 0 };
}
export function createConversationInsights({ request, jump }) {
  const style = document.createElement("link"); style.rel = "stylesheet"; style.href = "/conversation-insights.css"; document.head.append(style);
  const root = document.createElement("section"); root.className = "conversation-insights"; root.hidden = true;
  root.innerHTML = '<div class="insight-heading"><h3>對話洞察</h3><span>AI 輔助</span></div><label for="insight-scope">摘要範圍</label><div class="insight-controls"><select id="insight-scope"><option value="session">本次對話</option><option value="day">最近 24 小時</option><option value="recent">最近 30 則</option></select><button type="button">產生摘要</button></div><p class="insight-range"></p><p class="insight-status" role="status" aria-live="polite"></p><div class="insight-result" hidden></div><p class="insight-note">情緒只反映近期文字語氣；分析文字訊息，圖片與語音未納入。按下產生摘要會使用 AI 用量。</p>';
  document.getElementById("customer-form").before(root);
  const scope = root.querySelector("select"), button = root.querySelector("button"), rangeLabel = root.querySelector(".insight-range"), status = root.querySelector(".insight-status"), output = root.querySelector(".insight-result");
  let context = { id: null, items: [] }, version = 0, pending = false; const cache = new Map();
  const node = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; };
  function range() { return insightRange(context.items, scope.value); }
  function key() { return JSON.stringify([context.id, scope.value, range().messages]); }
  function render(saved) {
    output.replaceChildren(); output.hidden = !saved; if (!saved) return;
    const { result, updatedAt } = saved;
    const badges = node("div", "", "insight-emotions"); for (const emotion of result.emotions) badges.append(node("span", emotion)); output.append(badges, node("p", result.reason, "insight-reason"));
    for (const [label, field] of [["主要需求", "need"], ["目前進度", "progress"], ["待處理", "next"]]) { const section = node("div", "", "insight-summary-row"); section.append(node("strong", label), node("p", result[field])); output.append(section); }
    for (const id of result.sourceIds) { const message = context.items.find(m => m.id === id); if (!message) continue; const quote = node("button", `「${message.text.slice(0, 100)}」`, "insight-quote"); quote.type = "button"; quote.onclick = () => jump(id); output.append(quote); }
    output.append(node("small", `更新於 ${new Date(updatedAt).toLocaleString("zh-TW")}`));
  }
  function refresh() {
    const current = range(), list = current.messages;
    const time = value => new Date(value).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    rangeLabel.textContent = list.length ? `${time(list[0].sentAt)} — ${time(list.at(-1).sentAt)} · ${list.length} 則文字訊息${current.limited || context.hasOlder && !current.boundary && scope.value !== "recent" ? " · 僅涵蓋已載入範圍，可載入較早訊息後重算" : ""}` : "尚無可分析的文字訊息。";
    button.disabled = pending || !context.id || !list.length; button.textContent = pending ? "分析中…" : cache.has(key()) ? "重新分析" : "產生摘要";
    render(cache.get(key()));
  }
  scope.onchange = () => { version++; pending = false; status.textContent = ""; refresh(); };
  button.onclick = async () => {
    const requestVersion = ++version, requestKey = key(); pending = true; status.textContent = "正在整理摘要與近期語氣…"; refresh();
    try { const data = await request(range().messages); if (version !== requestVersion) return; cache.set(requestKey, data); if (cache.size > 20) cache.delete(cache.keys().next().value); status.textContent = ""; }
    catch (error) { if (version === requestVersion) status.textContent = error.message || "分析失敗，請重試。"; }
    finally { if (version === requestVersion) { pending = false; refresh(); } }
  };
  return { setContext(next) { const changed = context.id !== next.id; if (changed) { version++; pending = false; status.textContent = ""; } context = next; root.hidden = !next.id; refresh(); }, clear() { version++; pending = false; cache.clear(); context = { id: null, items: [] }; root.hidden = true; render(null); } };
}
