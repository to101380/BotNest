const $ = id => document.getElementById(id);
const trustedAvatar = (value, provider) => {
  try { const url = new URL(value); const trusted = provider === "facebook" ? (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com") || url.hostname.endsWith(".fbcdn.net") || url.hostname.endsWith(".fbsbx.com")) : url.hostname.endsWith(".line-scdn.net"); return url.protocol === "https:" && trusted ? url.href : ""; }
  catch { return ""; }
};
const customerName = item => item.customer?.name || item.displayName || `${item.provider === "facebook" ? "Messenger" : "LINE"} 顧客 · ${(item.sourceId || "").slice(-8)}`;
const formatDate = value => value ? new Date(value).toLocaleString("zh-TW", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

export function createCustomerManager() {
  let user = null, active = false, epoch = 0, controller = new AbortController(), loading = false, lineNext = null, facebookNext = null, channelReady = false;
  const customers = new Map();
  async function api(path) {
    const currentEpoch = epoch, currentUser = user;
    if (!active || !currentUser) throw new DOMException("Inactive", "AbortError");
    const token = await currentUser.getIdToken();
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    const response = await fetch(`/api/line/${path}`, { signal: controller.signal, cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({ error: "顧客資料服務暫時無法使用。" }));
    if (!response.ok || data.error) { const error = new Error(data.error || "顧客資料服務暫時無法使用。"); error.status = response.status; throw error; }
    return data;
  }
  async function zernioApi(path) {
    const currentEpoch = epoch, currentUser = user;
    if (!active || !currentUser) throw new DOMException("Inactive", "AbortError");
    const token = await currentUser.getIdToken();
    const response = await fetch(`/api/zernio/${path}`, { signal: controller.signal, cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({ error: "Messenger 顧客資料暫時無法使用。" }));
    if (currentEpoch !== epoch) throw new DOMException("Session changed", "AbortError");
    if (!response.ok || data.error) throw new Error(data.error || "Messenger 顧客資料暫時無法使用。");
    return data;
  }
  function status(text, error = false) { $("customers-status").textContent = text; $("customers-status").classList.toggle("error", error); }
  function makeAvatar(item) {
    const frame = document.createElement("span"); frame.className = "customer-list-avatar"; frame.textContent = [...customerName(item)][0] || "人";
    const source = trustedAvatar(item.pictureUrl, item.provider);
    if (source) { const image = document.createElement("img"); image.alt = ""; image.src = source; image.loading = "lazy"; image.referrerPolicy = "no-referrer"; image.addEventListener("error", () => image.remove(), { once: true }); frame.append(image); }
    const badge = document.createElement("span"); badge.className = item.provider === "facebook" ? "customer-messenger-badge" : "customer-line-badge"; badge.title = item.provider === "facebook" ? "Facebook Messenger" : "LINE"; frame.append(badge); return frame;
  }
  function textCell(value, className = "") { const cell = document.createElement("td"); cell.className = className; cell.textContent = value || "—"; return cell; }
  function openConversation(id) {
    try { sessionStorage.setItem("botnest-open-conversation", id); } catch { /* The inbox can still open without preselection. */ }
    location.hash = "#ai-robot";
  }
  function render() {
    const query = $("customers-search").value.trim().toLocaleLowerCase("zh-TW");
    const rows = [...customers.values()].filter(item => {
      const value = [customerName(item), item.displayName, item.sourceId, item.customer?.phone, item.customer?.email, ...(item.customer?.tags || [])].join(" ").toLocaleLowerCase("zh-TW");
      return !query || value.includes(query);
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    $("customers-list").replaceChildren(...rows.map(item => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td"), button = document.createElement("button"); button.type = "button"; button.className = "customer-name-button";
      const details = document.createElement("span"), strong = document.createElement("strong"), source = document.createElement("span");
      strong.textContent = customerName(item); source.textContent = item.provider === "facebook" ? "來自 Facebook Messenger" : "來自 LINE"; details.append(strong, source); button.append(makeAvatar(item), details); button.addEventListener("click", () => openConversation(item.id)); nameCell.append(button); row.append(nameCell);
      row.append(textCell(formatDate(item.createdAt || item.updatedAt)), textCell(formatDate(item.updatedAt)), textCell(item.customer?.phone), textCell(item.customer?.email));
      const tags = document.createElement("td"), tagWrap = document.createElement("div"); tagWrap.className = "customer-list-tags";
      for (const value of item.customer?.tags || []) { const tag = document.createElement("span"); tag.textContent = value; tagWrap.append(tag); }
      if (!tagWrap.children.length) tagWrap.textContent = "—"; tags.append(tagWrap); row.append(tags); return row;
    }));
    $("customers-count").textContent = `${customers.size} 位顧客`;
    $("customers-empty").hidden = rows.length > 0 || loading;
    $("customers-more").hidden = (!lineNext && !facebookNext) || !!query;
    if (query) status(`找到 ${rows.length} 位符合的顧客${lineNext || facebookNext ? "（可先載入更多顧客再搜尋）" : ""}`);
    else if (!loading && channelReady) status(customers.size ? "點選顧客姓名可開啟對話與編輯完整資料。" : "LINE 或 Messenger 使用者傳送訊息後，會自動建立顧客名單。");
  }
  async function load(more = false) {
    if (!active || loading) return;
    const currentEpoch = epoch; loading = true; $("customers-refresh").disabled = $("customers-more").disabled = true; status("正在讀取顧客名單…"); render();
    try {
      if (!more) {
        const [lineAccount, facebookAccount] = await Promise.allSettled([api("account"), zernioApi("account")]);
        channelReady = !!lineAccount.value?.channel || !!facebookAccount.value?.facebook;
        if (!channelReady) { customers.clear(); lineNext = facebookNext = null; status("請先到渠道設定連接 LINE OA 或 Facebook Messenger。", true); return; }
      }
      const requests = [];
      if (!more || lineNext) requests.push(api(`conversations${more && lineNext ? `?before=${encodeURIComponent(lineNext)}` : ""}`).then(data => ({ provider: "line", data })).catch(error => ({ provider: "line", error })));
      if (!more || facebookNext) requests.push(zernioApi(`conversations${more && facebookNext ? `?cursor=${encodeURIComponent(facebookNext)}` : ""}`).then(data => ({ provider: "facebook", data })).catch(error => ({ provider: "facebook", error })));
      const results = await Promise.all(requests);
      if (currentEpoch !== epoch) return;
      if (!more) customers.clear();
      let loaded = false, lastError;
      for (const result of results) {
        if (result.error) { lastError = result.error; continue; }
        loaded = true;
        for (const item of result.data.items || []) customers.set(item.id, { ...item, provider: result.provider });
        if (result.provider === "line") lineNext = result.data.next; else facebookNext = result.data.next;
      }
      if (!loaded && lastError) throw lastError;
    } catch (error) { if (error.name !== "AbortError") status(error.message, true); }
    finally { if (currentEpoch === epoch) { loading = false; $("customers-refresh").disabled = $("customers-more").disabled = false; render(); } }
  }
  $("customers-search").addEventListener("input", render);
  $("customers-refresh").addEventListener("click", () => void load());
  $("customers-more").addEventListener("click", () => void load(true));
  return {
    setSession(nextUser, visible) {
      const nextActive = !!nextUser && visible;
      if (user?.uid === nextUser?.uid && active === nextActive) { user = nextUser; return; }
      epoch++; controller.abort(); controller = new AbortController(); user = nextUser; active = nextActive; loading = false; lineNext = facebookNext = null; channelReady = false; customers.clear();
      $("customers-search").value = ""; $("customers-list").replaceChildren(); $("customers-count").textContent = "0 位顧客"; status(""); render();
      if (active) void load();
    },
  };
}
