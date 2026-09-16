const $ = id => document.getElementById(id);
const trustedLineImage = value => {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname.endsWith(".line-scdn.net") ? url.href : ""; }
  catch { return ""; }
};
const customerName = item => item.customer?.name || item.displayName || `LINE 顧客 · ${item.sourceId.slice(-8)}`;
const formatDate = value => value ? new Date(value).toLocaleString("zh-TW", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

export function createCustomerManager() {
  let user = null, active = false, epoch = 0, controller = new AbortController(), loading = false, next = null, channelReady = false;
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
  function status(text, error = false) { $("customers-status").textContent = text; $("customers-status").classList.toggle("error", error); }
  function makeAvatar(item) {
    const frame = document.createElement("span"); frame.className = "customer-list-avatar"; frame.textContent = [...customerName(item)][0] || "人";
    const source = trustedLineImage(item.pictureUrl);
    if (source) { const image = document.createElement("img"); image.alt = ""; image.src = source; image.loading = "lazy"; image.referrerPolicy = "no-referrer"; image.addEventListener("error", () => image.remove(), { once: true }); frame.append(image); }
    const badge = document.createElement("span"); badge.className = "customer-line-badge"; badge.title = "LINE"; frame.append(badge); return frame;
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
      strong.textContent = customerName(item); source.textContent = "來自 LINE"; details.append(strong, source); button.append(makeAvatar(item), details); button.addEventListener("click", () => openConversation(item.id)); nameCell.append(button); row.append(nameCell);
      row.append(textCell(formatDate(item.createdAt || item.updatedAt)), textCell(formatDate(item.updatedAt)), textCell(item.customer?.phone), textCell(item.customer?.email));
      const tags = document.createElement("td"), tagWrap = document.createElement("div"); tagWrap.className = "customer-list-tags";
      for (const value of item.customer?.tags || []) { const tag = document.createElement("span"); tag.textContent = value; tagWrap.append(tag); }
      if (!tagWrap.children.length) tagWrap.textContent = "—"; tags.append(tagWrap); row.append(tags); return row;
    }));
    $("customers-count").textContent = `${customers.size} 位顧客`;
    $("customers-empty").hidden = rows.length > 0 || loading;
    $("customers-more").hidden = !next || !!query;
    if (query) status(`找到 ${rows.length} 位符合的顧客${next ? "（可先載入更多顧客再搜尋）" : ""}`);
    else if (!loading && channelReady) status(customers.size ? "點選顧客姓名可開啟對話與編輯完整資料。" : "LINE 使用者傳送訊息後，會自動建立顧客名單。");
  }
  async function load(more = false) {
    if (!active || loading) return;
    const currentEpoch = epoch; loading = true; $("customers-refresh").disabled = $("customers-more").disabled = true; status("正在讀取顧客名單…"); render();
    try {
      if (!more) {
        const account = await api("account");
        channelReady = !!account.channel;
        if (!channelReady) { customers.clear(); next = null; status("請先到 AI機器人頁面連接 LINE OA。", true); return; }
      }
      const data = await api(`conversations${more && next ? `?before=${encodeURIComponent(next)}` : ""}`);
      if (currentEpoch !== epoch) return;
      if (!more) customers.clear();
      for (const item of data.items) customers.set(item.id, item);
      next = data.next;
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
      epoch++; controller.abort(); controller = new AbortController(); user = nextUser; active = nextActive; loading = false; next = null; channelReady = false; customers.clear();
      $("customers-search").value = ""; $("customers-list").replaceChildren(); $("customers-count").textContent = "0 位顧客"; status(""); render();
      if (active) void load();
    },
  };
}
